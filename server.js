const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    // Tolera mejor microcortes de Wi‑Fi / datos móviles y suspensión breve del navegador.
    pingInterval: 25000,
    pingTimeout: 60000,

    // Socket.IO intenta recuperar la conexión y las rooms automáticamente.
    connectionStateRecovery: {
        maxDisconnectionDuration: 5 * 60 * 1000,
        skipMiddlewares: true
    }
});
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const MIN_JUGADORES = 2;
const MAX_JUGADORES = 8;
const CARTAS_POR_JUGADOR = 4;
const TIEMPO_DEFAULT = 40;
const TIEMPO_MIN = 10;
const TIEMPO_MAX = 60;
const PUNTAJE_DEFAULT = 200;
const PUNTAJE_MIN = 20;
const PUNTAJE_MAX = 1000;
const GRACIA_RECONEXION_MS = 5 * 60 * 1000;

const salas = new Map();

function nuevaSala(codigo, anfitrionId) {
    return {
        codigo,
        anfitrionId,
        jugadores: [],
        mazo: [],
        cementerio: [],
        partidaIniciada: false,
        fasePreparacion: false,
        faseEntreRondas: false,
        ronda: 0,
        indiceTurno: 0,
        tiempoPorTurno: TIEMPO_DEFAULT,
        puntajeObjetivo: PUNTAJE_DEFAULT,
        temporizadorTurno: null,
        temporizadorPreparacion: null,
        finTurno: null,
        finPreparacion: null,
        versionCementerio: 0,
        intentosSalto: new Set()
    };
}

function generarCodigoSala() {
    const caracteres = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let codigo;
    do {
        codigo = "";
        for (let i = 0; i < 6; i++) {
            codigo += caracteres[Math.floor(Math.random() * caracteres.length)];
        }
    } while (salas.has(codigo));
    return codigo;
}

function salaDeSocket(socket) {
    return salas.get(socket.data.codigoSala) || null;
}

function emitirSala(sala, evento, datos) {
    io.to(sala.codigo).emit(evento, datos);
}

function buscarJugador(sala, id) {
    return sala.jugadores.find(j => j.id === id);
}

function esTurno(sala, id) {
    if (!sala.partidaIniciada || sala.fasePreparacion || sala.faseEntreRondas) return false;
    return sala.jugadores[sala.indiceTurno]?.id === id;
}

function jugadoresPublicos(sala) {
    return sala.jugadores.map(j => ({
        id: j.id,
        nombre: j.nombre,
        puntos: j.puntos,
        listo: j.listo,
        listoEntreRondas: j.listoEntreRondas,
        esAnfitrion: j.id === sala.anfitrionId,
        conectado: j.conectado !== false,
        cartas: j.cartas.map(() => ({ oculta: true }))
    }));
}

function enviarJugadores(sala) {
    emitirSala(sala, "jugadoresActualizados", {
        jugadores: jugadoresPublicos(sala),
        partidaIniciada: sala.partidaIniciada,
        fasePreparacion: sala.fasePreparacion,
        faseEntreRondas: sala.faseEntreRondas,
        ronda: sala.ronda,
        codigoSala: sala.codigo,
        anfitrionId: sala.anfitrionId,
        tiempoPorTurno: sala.tiempoPorTurno,
        puntajeObjetivo: sala.puntajeObjetivo
    });
}

function enviarCartasPropias(jugador) {
    io.to(jugador.id).emit("cartasActuales", {
        cartas: jugador.cartas.map(c => ({
            numero: c.numero,
            palo: c.palo,
            valor: valorCarta(c)
        }))
    });
}

function crearMazo() {
    const palos = ["oros", "copas", "espadas", "bastos"];
    const mazo = [];
    for (const palo of palos) {
        for (let numero = 1; numero <= 12; numero++) {
            mazo.push({ numero, palo, viva: true });
        }
    }
    return mazo;
}

function mezclar(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function valorCarta(carta) {
    if (!carta) return 0;
    return carta.numero === 12 && carta.palo === "espadas" ? 0 : carta.numero;
}

function tipoPoder(numero) {
    if (numero === 6 || numero === 7) return "verPropia";
    if (numero === 8 || numero === 9) return "verRival";
    if (numero === 10 || numero === 11) return "intercambiar";
    return null;
}

function nuevaVersionCementerio(sala) {
    sala.versionCementerio++;
    sala.intentosSalto = new Set();
}

function cartaSuperiorCementerio(sala) {
    return sala.cementerio.at(-1) || null;
}

function enviarCementerio(sala) {
    const carta = cartaSuperiorCementerio(sala);
    emitirSala(sala, "cementerioActualizado", {
        carta: carta ? {
            numero: carta.numero,
            palo: carta.palo,
            valor: valorCarta(carta),
            version: sala.versionCementerio
        } : null
    });
}

function ponerEnCementerio(sala, carta) {
    carta.viva = false;
    sala.cementerio.push(carta);
    nuevaVersionCementerio(sala);
    enviarCementerio(sala);
}

function quitarSuperiorCementerio(sala) {
    if (!sala.cementerio.length) return null;
    const carta = sala.cementerio.pop();
    nuevaVersionCementerio(sala);
    enviarCementerio(sala);
    return carta;
}

function reciclarCementerio(sala) {
    if (sala.cementerio.length <= 1) return;
    const superior = sala.cementerio.pop();
    while (sala.cementerio.length) {
        const carta = sala.cementerio.pop();
        carta.viva = true;
        sala.mazo.push(carta);
    }
    sala.cementerio.push(superior);
    mezclar(sala.mazo);
    enviarCementerio(sala);
}

function sacarDelMazo(sala) {
    if (!sala.mazo.length) reciclarCementerio(sala);
    return sala.mazo.pop() || null;
}

function detenerTemporizadorTurno(sala) {
    if (sala.temporizadorTurno) clearTimeout(sala.temporizadorTurno);
    sala.temporizadorTurno = null;
    sala.finTurno = null;
}

function detenerTemporizadorPreparacion(sala) {
    if (sala.temporizadorPreparacion) clearTimeout(sala.temporizadorPreparacion);
    sala.temporizadorPreparacion = null;
    sala.finPreparacion = null;
}

function devolverCartaPendiente(sala, jugador) {
    if (!jugador?.cartaSacada) return;
    if (jugador.desdeCementerio) {
        ponerEnCementerio(sala, jugador.cartaSacada);
    } else {
        jugador.cartaSacada.viva = true;
        sala.mazo.push(jugador.cartaSacada);
    }
    jugador.cartaSacada = null;
    jugador.desdeCementerio = false;
}

function iniciarTemporizadorDeTurno(sala) {
    detenerTemporizadorTurno(sala);
    if (!sala.partidaIniciada || sala.fasePreparacion || sala.faseEntreRondas) return;
    const jugador = sala.jugadores[sala.indiceTurno];
    if (!jugador) return;

    emitirSala(sala, "temporizadorIniciado", {
        segundos: sala.tiempoPorTurno,
        jugadorId: jugador.id
    });

    sala.finTurno = Date.now() + sala.tiempoPorTurno * 1000;

    sala.temporizadorTurno = setTimeout(() => {
        if (!salas.has(sala.codigo)) return;
        const actual = sala.jugadores[sala.indiceTurno];
        if (!actual) return;
        devolverCartaPendiente(sala, actual);
        actual.accionEspecial = null;
        emitirSala(sala, "turnoAgotado", {
            jugadorId: actual.id,
            jugadorNombre: actual.nombre
        });
        pasarTurno(sala);
    }, sala.tiempoPorTurno * 1000);
}

function enviarTurnoActual(sala) {
    const jugador = sala.jugadores[sala.indiceTurno];
    emitirSala(sala, "turnoActual", {
        jugadorId: jugador?.id || null,
        jugadorNombre: jugador?.nombre || ""
    });
}

function pasarTurno(sala) {
    if (!sala.partidaIniciada || sala.fasePreparacion || sala.faseEntreRondas || !sala.jugadores.length) return;
    detenerTemporizadorTurno(sala);
    const anterior = sala.jugadores[sala.indiceTurno];
    if (anterior) {
        anterior.accionEspecial = null;
        devolverCartaPendiente(sala, anterior);
    }
    sala.indiceTurno = (sala.indiceTurno + 1) % sala.jugadores.length;
    enviarTurnoActual(sala);
    enviarJugadores(sala);
    iniciarTemporizadorDeTurno(sala);
}

function repartirCartas(sala) {
    for (const jugador of sala.jugadores) {
        jugador.cartas = [];
        jugador.cartaSacada = null;
        jugador.desdeCementerio = false;
        jugador.accionEspecial = null;
        jugador.listo = false;
        jugador.listoEntreRondas = false;
        for (let i = 0; i < CARTAS_POR_JUGADOR; i++) {
            const carta = sacarDelMazo(sala);
            if (carta) {
                carta.viva = false;
                jugador.cartas.push(carta);
            }
        }
        enviarCartasPropias(jugador);
    }
    enviarJugadores(sala);
}

function comenzarPreparacion(sala) {
    sala.fasePreparacion = true;
    sala.faseEntreRondas = false;
    sala.jugadores.forEach(j => {
        j.listo = false;
        j.listoEntreRondas = false;
    });
    emitirSala(sala, "fasePreparacion", { segundos: sala.tiempoPorTurno });
    enviarJugadores(sala);
    detenerTemporizadorPreparacion(sala);
    sala.finPreparacion = Date.now() + sala.tiempoPorTurno * 1000;

    sala.temporizadorPreparacion = setTimeout(() => {
        if (salas.has(sala.codigo)) finalizarPreparacion(sala);
    }, sala.tiempoPorTurno * 1000);
}

function finalizarPreparacion(sala) {
    if (!sala.fasePreparacion) return;
    detenerTemporizadorPreparacion(sala);
    sala.fasePreparacion = false;
    sala.jugadores.forEach(j => j.listo = false);
    emitirSala(sala, "finFasePreparacion");
    // Rota quién empieza: ronda 1 jugador 1, ronda 2 jugador 2, etc.
    sala.indiceTurno = sala.jugadores.length ? (sala.ronda - 1) % sala.jugadores.length : 0;
    enviarJugadores(sala);
    enviarTurnoActual(sala);
    iniciarTemporizadorDeTurno(sala);
}

function comenzarRonda(sala) {
    detenerTemporizadorTurno(sala);
    detenerTemporizadorPreparacion(sala);
    sala.faseEntreRondas = false;
    sala.mazo = crearMazo();
    mezclar(sala.mazo);
    sala.cementerio = [];
    nuevaVersionCementerio(sala);
    sala.ronda++;
    emitirSala(sala, "nuevaRonda", { ronda: sala.ronda });
    enviarCementerio(sala);
    repartirCartas(sala);
    comenzarPreparacion(sala);
}

function cantarPedro(sala, socket) {
    if (!sala.partidaIniciada || sala.faseEntreRondas) return;
    detenerTemporizadorTurno(sala);
    detenerTemporizadorPreparacion(sala);
    sala.fasePreparacion = false;
    sala.jugadores.forEach(j => {
        devolverCartaPendiente(sala, j);
        j.accionEspecial = null;
        j.listoEntreRondas = false;
    });

    const resultados = sala.jugadores.map(j => {
        const puntosRonda = j.cartas.reduce((s, c) => s + valorCarta(c), 0);
        j.puntos += puntosRonda;
        return {
            id: j.id,
            nombre: j.nombre,
            cartas: j.cartas.map(c => ({ numero: c.numero, palo: c.palo, valor: valorCarta(c) })),
            puntosRonda,
            puntosTotales: j.puntos
        };
    });

    const llamador = buscarJugador(sala, socket.id);
    const hayFinal = sala.jugadores.some(j => j.puntos >= sala.puntajeObjetivo);
    emitirSala(sala, "rondaTerminada", {
        ronda: sala.ronda,
        resultados,
        hayFinal,
        llamadoPor: { id: socket.id, nombre: llamador?.nombre || "Jugador" }
    });

    if (hayFinal) {
        sala.partidaIniciada = false;
        sala.faseEntreRondas = false;
        const ranking = [...sala.jugadores].sort((a,b) => a.puntos - b.puntos);
        emitirSala(sala, "partidaTerminada", {
            jugadores: ranking.map(j => ({ id:j.id, nombre:j.nombre, puntos:j.puntos })),
            ganador: ranking[0] ? { id:ranking[0].id, nombre:ranking[0].nombre, puntos:ranking[0].puntos } : null
        });
        enviarJugadores(sala);
        return;
    }

    sala.faseEntreRondas = true;
    enviarJugadores(sala);
    emitirSala(sala, "esperandoSiguienteRonda", { listos:0, total:sala.jugadores.length });
}

function validarNombre(sala, socket, nombre) {
    const limpio = String(nombre || "").trim();
    if (!limpio) { socket.emit("errorJuego", "Escribí tu nombre."); return null; }
    if (limpio.length > 18) { socket.emit("errorJuego", "El nombre puede tener como máximo 18 caracteres."); return null; }
    if (sala?.jugadores.some(j => j.nombre.toLowerCase() === limpio.toLowerCase())) {
        socket.emit("errorJuego", "Ya hay un jugador con ese nombre en la sala."); return null;
    }
    return limpio;
}

function agregarJugadorASala(sala, socket, nombre, sessionToken) {
    const limpio = validarNombre(sala, socket, nombre);
    if (!limpio) return false;
    if (sala.partidaIniciada) { socket.emit("errorJuego", "La partida de esa sala ya comenzó."); return false; }
    if (sala.jugadores.length >= MAX_JUGADORES) { socket.emit("errorJuego", "La sala está llena."); return false; }

    const token = String(sessionToken || "").trim();
    if (!token) { socket.emit("errorJuego", "No se pudo crear la sesión del jugador."); return false; }

    // Un sessionToken identifica a UN jugador real.
    // Si otra pestaña con el mismo localStorage intenta entrar como otro jugador,
    // evitamos duplicarlo porque después un disconnect podría afectar a la sesión equivocada.
    const sesionExistente = buscarJugadorPorSesion(token);
    if (sesionExistente) {
        const existente = sesionExistente.jugador;

        if (existente.conectado !== false) {
            socket.emit(
                "errorJuego",
                "Esta sesión ya está siendo usada por otro jugador/pestaña. Usá otro navegador, modo incógnito independiente o salí de la sala anterior."
            );
            return false;
        }

        socket.emit(
            "errorJuego",
            "Ya existe una sesión desconectada con este navegador. Esperá la reconexión automática o salí de la sala anterior."
        );
        return false;
    }

    socket.join(sala.codigo);
    socket.data.codigoSala = sala.codigo;
    socket.data.sessionToken = token;

    sala.jugadores.push({
        id: socket.id,
        sessionToken: token,
        nombre: limpio,
        cartas: [],
        puntos: 0,
        cartaSacada: null,
        desdeCementerio: false,
        accionEspecial: null,
        listo: false,
        listoEntreRondas: false,
        conectado: true,
        temporizadorExpulsion: null
    });

    socket.emit("entradaConfirmada", {
        id: socket.id,
        nombre: limpio,
        codigoSala: sala.codigo,
        esAnfitrion: socket.id === sala.anfitrionId
    });
    enviarJugadores(sala);
    return true;
}

function buscarJugadorPorSesion(sessionToken) {
    const token = String(sessionToken || "").trim();
    if (!token) return null;

    for (const sala of salas.values()) {
        const jugador = sala.jugadores.find(j => j.sessionToken === token);
        if (jugador) return { sala, jugador };
    }

    return null;
}

function datosCementerioParaCliente(sala) {
    const carta = cartaSuperiorCementerio(sala);
    return {
        carta: carta ? {
            numero: carta.numero,
            palo: carta.palo,
            valor: valorCarta(carta),
            version: sala.versionCementerio
        } : null
    };
}

function restaurarJugador(socket, sessionToken) {
    const encontrado = buscarJugadorPorSesion(sessionToken);
    if (!encontrado) {
        socket.emit("reconexionFallida");
        return false;
    }

    const { sala, jugador } = encontrado;
    const idAnterior = jugador.id;

    if (jugador.temporizadorExpulsion) {
        clearTimeout(jugador.temporizadorExpulsion);
        jugador.temporizadorExpulsion = null;
    }

    jugador.id = socket.id;
    jugador.conectado = true;

    console.log(
        `[reconnect] sala=${sala.codigo} jugador=${jugador.nombre} oldSocket=${idAnterior} newSocket=${socket.id}`
    );

    socket.join(sala.codigo);
    socket.data.codigoSala = sala.codigo;
    socket.data.sessionToken = jugador.sessionToken;

    if (sala.anfitrionId === idAnterior) {
        sala.anfitrionId = socket.id;
    }

    socket.emit("entradaConfirmada", {
        id: socket.id,
        nombre: jugador.nombre,
        codigoSala: sala.codigo,
        esAnfitrion: socket.id === sala.anfitrionId,
        reconectado: true
    });

    enviarJugadores(sala);
    enviarCartasPropias(jugador);
    socket.emit("cementerioActualizado", datosCementerioParaCliente(sala));

    if (sala.fasePreparacion) {
        const restantes = sala.finPreparacion
            ? Math.max(1, Math.ceil((sala.finPreparacion - Date.now()) / 1000))
            : sala.tiempoPorTurno;
        socket.emit("fasePreparacion", { segundos: restantes });
    } else if (sala.partidaIniciada && !sala.faseEntreRondas) {
        const actual = sala.jugadores[sala.indiceTurno];
        socket.emit("turnoActual", {
            jugadorId: actual?.id || null,
            jugadorNombre: actual?.nombre || ""
        });

        const restantes = sala.finTurno
            ? Math.max(1, Math.ceil((sala.finTurno - Date.now()) / 1000))
            : sala.tiempoPorTurno;
        socket.emit("temporizadorIniciado", {
            segundos: restantes,
            jugadorId: actual?.id || null
        });
    } else if (sala.faseEntreRondas) {
        const listos = sala.jugadores.filter(j => j.listoEntreRondas).length;
        socket.emit("esperandoSiguienteRonda", {
            listos,
            total: sala.jugadores.length
        });
    }

    socket.emit("reconexionExitosa", {
        codigoSala: sala.codigo,
        nombre: jugador.nombre
    });

    return true;
}

function eliminarJugadorDefinitivamente(sala, jugador) {
    const indice = sala.jugadores.indexOf(jugador);
    if (indice === -1) return;

    const eraAnfitrion = sala.anfitrionId === jugador.id;
    const eraTurno = sala.jugadores[sala.indiceTurno] === jugador;

    sala.jugadores.splice(indice, 1);

    if (!sala.jugadores.length) {
        detenerTemporizadorTurno(sala);
        detenerTemporizadorPreparacion(sala);
        salas.delete(sala.codigo);
        return;
    }

    if (eraAnfitrion) {
        const nuevo = sala.jugadores.find(j => j.conectado !== false) || sala.jugadores[0];
        sala.anfitrionId = nuevo.id;
        emitirSala(sala, "anfitrionCambiado", {
            anfitrionId: nuevo.id,
            nombre: nuevo.nombre
        });
    }

    if (indice < sala.indiceTurno) {
        sala.indiceTurno--;
    } else if (eraTurno && sala.indiceTurno >= sala.jugadores.length) {
        sala.indiceTurno = 0;
    }

    if (sala.indiceTurno < 0) sala.indiceTurno = 0;

    if (sala.partidaIniciada && sala.jugadores.length < MIN_JUGADORES) {
        sala.partidaIniciada = false;
        sala.fasePreparacion = false;
        sala.faseEntreRondas = false;
        sala.ronda = 0;
        detenerTemporizadorTurno(sala);
        detenerTemporizadorPreparacion(sala);
        sala.jugadores.forEach(j => {
            j.cartas = [];
            j.cartaSacada = null;
            j.accionEspecial = null;
            j.listo = false;
            j.listoEntreRondas = false;
        });
        emitirSala(sala, "partidaReiniciada", {
            motivo: "No quedan suficientes jugadores para continuar."
        });
    } else if (
        sala.partidaIniciada &&
        sala.faseEntreRondas &&
        sala.jugadores.every(j => j.listoEntreRondas)
    ) {
        comenzarRonda(sala);
        return;
    }

    enviarJugadores(sala);

    if (sala.partidaIniciada && !sala.faseEntreRondas && !sala.fasePreparacion) {
        enviarTurnoActual(sala);
    }
}

io.on("connection", socket => {
    socket.emit("estadoInicial", {
        jugadores: [],
        partidaIniciada: false,
        fasePreparacion: false,
        faseEntreRondas: false,
        ronda: 0,
        tiempoPorTurno: TIEMPO_DEFAULT,
        codigoSala: null,
        anfitrionId: null
    });

    socket.on("reconectarSala", datos => {
        if (socket.data.codigoSala) return;
        restaurarJugador(socket, datos?.sessionToken);
    });

    socket.on("crearSala", datos => {
        if (socket.data.codigoSala) return;
        const nombre = typeof datos === "string" ? datos : datos?.nombre;
        const sessionToken = typeof datos === "string" ? null : datos?.sessionToken;
        const codigo = generarCodigoSala();
        const sala = nuevaSala(codigo, socket.id);
        salas.set(codigo, sala);
        if (agregarJugadorASala(sala, socket, nombre, sessionToken)) {
            socket.emit("salaCreada", { codigoSala: codigo });
        } else {
            salas.delete(codigo);
        }
    });

    socket.on("unirseSala", datos => {
        if (socket.data.codigoSala) return;
        const codigo = String(datos?.codigo || "").trim().toUpperCase();
        const sala = salas.get(codigo);
        if (!sala) { socket.emit("errorJuego", "No existe una sala con ese código."); return; }
        agregarJugadorASala(sala, socket, datos?.nombre, datos?.sessionToken);
    });

    // ==================================================
    // SALIR VOLUNTARIAMENTE DE LA SALA
    // ==================================================

    socket.on("salirSala", () => {
        const codigo = socket.data.codigoSala;
        const sala = salas.get(codigo);

        if (!sala) {
            socket.data.codigoSala = null;
            socket.data.sessionToken = null;
            socket.emit("salidaSalaConfirmada");
            return;
        }

        // Una salida voluntaria solo puede afectar al socket que la pidió.
        // Nunca usamos sessionToken acá para evitar sacar a otro jugador por error.
        const jugador = sala.jugadores.find(
            j => j.id === socket.id
        );

        if (!jugador) {
            socket.leave(sala.codigo);
            socket.data.codigoSala = null;
            socket.data.sessionToken = null;
            socket.emit("salidaSalaConfirmada");
            return;
        }

        // Una salida voluntaria NO usa el período de gracia de reconexión.
        if (jugador.temporizadorExpulsion) {
            clearTimeout(jugador.temporizadorExpulsion);
            jugador.temporizadorExpulsion = null;
        }

        socket.leave(sala.codigo);

        // Limpiamos primero los datos del socket para que, si el navegador
        // se recarga después, el disconnect no vuelva a programar reconexión.
        socket.data.codigoSala = null;
        socket.data.sessionToken = null;

        eliminarJugadorDefinitivamente(sala, jugador);

        socket.emit("salidaSalaConfirmada");
    });

    // Compatibilidad local con clientes anteriores: crea una sala automáticamente.
    socket.on("entrarPartida", nombre => {
        if (socket.data.codigoSala) return;
        const codigo = generarCodigoSala();
        const sala = nuevaSala(codigo, socket.id);
        salas.set(codigo, sala);
        if (!agregarJugadorASala(sala, socket, nombre, `legacy-${socket.id}`)) salas.delete(codigo);
    });

    socket.on("iniciarPartida", datos => {
        const sala = salaDeSocket(socket);
        if (!sala || sala.partidaIniciada) return;
        if (socket.id !== sala.anfitrionId) {
            socket.emit("errorJuego", "Solo el anfitrión puede iniciar la partida.");
            return;
        }
        if (sala.jugadores.length < MIN_JUGADORES) {
            socket.emit("errorJuego", "Se necesitan al menos 2 jugadores.");
            return;
        }

        const tiempoRecibido =
            typeof datos === "object"
                ? datos?.segundos
                : datos;

        const puntajeRecibido =
            typeof datos === "object"
                ? datos?.puntajeObjetivo
                : PUNTAJE_DEFAULT;

        let tiempo = Number(tiempoRecibido);

        if (!Number.isFinite(tiempo)) {
            tiempo = TIEMPO_DEFAULT;
        }

        sala.tiempoPorTurno =
            Math.max(
                TIEMPO_MIN,
                Math.min(
                    TIEMPO_MAX,
                    Math.round(tiempo)
                )
            );

        let puntajeObjetivo =
            Number(puntajeRecibido);

        if (!Number.isFinite(puntajeObjetivo)) {
            puntajeObjetivo = PUNTAJE_DEFAULT;
        }

        sala.puntajeObjetivo =
            Math.max(
                PUNTAJE_MIN,
                Math.min(
                    PUNTAJE_MAX,
                    Math.round(puntajeObjetivo)
                )
            );

        sala.partidaIniciada = true;
        sala.faseEntreRondas = false;
        sala.ronda = 0;

        sala.jugadores.forEach(j => {
            j.puntos = 0;
            j.listoEntreRondas = false;
        });

        emitirSala(
            sala,
            "partidaIniciada",
            {
                tiempoPorTurno: sala.tiempoPorTurno,
                puntajeObjetivo: sala.puntajeObjetivo
            }
        );

        comenzarRonda(sala);
    });

    socket.on("sacarCarta", () => {
        const sala = salaDeSocket(socket); if (!sala) return;
        const jugador = buscarJugador(sala, socket.id);
        if (!jugador || !esTurno(sala, socket.id) || jugador.cartaSacada || jugador.accionEspecial) return;
        const carta = sacarDelMazo(sala); if (!carta) return;
        jugador.cartaSacada = carta; jugador.desdeCementerio = false;
        socket.emit("cartaSacada", { carta:{ numero:carta.numero, palo:carta.palo, valor:valorCarta(carta), viva:true } });
    });

    socket.on("sacarDelCementerio", () => {
        const sala = salaDeSocket(socket); if (!sala) return;
        const jugador = buscarJugador(sala, socket.id);
        if (!jugador || !esTurno(sala, socket.id) || jugador.cartaSacada || jugador.accionEspecial) return;
        const carta = quitarSuperiorCementerio(sala);
        if (!carta) { socket.emit("errorJuego", "El cementerio está vacío."); return; }
        carta.viva = false; jugador.cartaSacada = carta; jugador.desdeCementerio = true;
        socket.emit("cartaSacada", { carta:{ numero:carta.numero, palo:carta.palo, valor:valorCarta(carta), viva:false } });
    });

    socket.on("tomarCementerioYReemplazar", indice => {
        const sala = salaDeSocket(socket); if (!sala) return;
        const jugador = buscarJugador(sala, socket.id);
        const i = Number(indice);
        if (!jugador || !esTurno(sala, socket.id) || jugador.cartaSacada || jugador.accionEspecial || !Number.isInteger(i) || i<0 || i>=jugador.cartas.length) return;
        const tomada = quitarSuperiorCementerio(sala); if (!tomada) return;
        tomada.viva = false;
        const vieja = jugador.cartas[i]; vieja.viva = false;
        jugador.cartas[i] = tomada;
        ponerEnCementerio(sala, vieja);
        enviarCartasPropias(jugador);
        emitirSala(sala, "cartaReemplazada", { jugadorId:jugador.id, jugadorNombre:jugador.nombre, numero:vieja.numero });
        pasarTurno(sala);
    });

    socket.on("tirarAlCementerio", () => {
        const sala = salaDeSocket(socket); if (!sala) return;
        const jugador = buscarJugador(sala, socket.id);
        if (!jugador || !esTurno(sala, socket.id) || !jugador.cartaSacada) return;
        const carta = jugador.cartaSacada;
        const poder = !jugador.desdeCementerio && carta.viva === true ? tipoPoder(carta.numero) : null;
        jugador.cartaSacada = null; jugador.desdeCementerio = false;
        ponerEnCementerio(sala, carta);
        emitirSala(sala, "cartaDescartada", { jugadorId:jugador.id, jugadorNombre:jugador.nombre, numero:carta.numero, palo:carta.palo });
        if (poder) {
            jugador.accionEspecial = { tipo:poder, numero:carta.numero, usada:false };
            socket.emit("poderDisponible", { tipo:poder, numero:carta.numero });
            iniciarTemporizadorDeTurno(sala);
            return;
        }
        pasarTurno(sala);
    });

    socket.on("reemplazarCarta", indice => {
        const sala = salaDeSocket(socket); if (!sala) return;
        const jugador = buscarJugador(sala, socket.id);
        const i = Number(indice);
        if (!jugador || !esTurno(sala, socket.id) || !jugador.cartaSacada || !Number.isInteger(i) || i<0 || i>=jugador.cartas.length) return;
        const nueva = jugador.cartaSacada;
        const vieja = jugador.cartas[i];
        jugador.cartaSacada = null; jugador.desdeCementerio = false;
        nueva.viva = false; vieja.viva = false;
        jugador.cartas[i] = nueva;
        ponerEnCementerio(sala, vieja);
        enviarCartasPropias(jugador);
        emitirSala(sala, "cartaReemplazada", { jugadorId:jugador.id, jugadorNombre:jugador.nombre, numero:vieja.numero });
        pasarTurno(sala);
    });

    socket.on("intentarSaltoDeFe", indice => {
        const sala = salaDeSocket(socket); if (!sala || !sala.partidaIniciada || sala.fasePreparacion || sala.faseEntreRondas) return;
        const jugador = buscarJugador(sala, socket.id); if (!jugador) return;
        const superior = cartaSuperiorCementerio(sala);
        if (!superior) { socket.emit("errorJuego", "No hay ninguna carta en el cementerio."); return; }
        const clave = `${sala.versionCementerio}:${jugador.id}`;
        if (sala.intentosSalto.has(clave)) { socket.emit("errorJuego", "Ya intentaste sobre esta carta del cementerio."); return; }
        const i = Number(indice);
        if (!Number.isInteger(i) || i<0 || i>=jugador.cartas.length) return;
        sala.intentosSalto.add(clave);
        const carta = jugador.cartas[i];
        if (carta.numero === superior.numero) {
            jugador.cartas.splice(i,1); carta.viva=false; ponerEnCementerio(sala,carta); enviarCartasPropias(jugador);
            emitirSala(sala,"saltoDeFeAcertado",{jugadorId:jugador.id,jugadorNombre:jugador.nombre,numero:carta.numero});
            return;
        }
        const penalizacion = sacarDelMazo(sala);
        if (penalizacion) {
            penalizacion.viva=false; jugador.cartas.push(penalizacion); enviarCartasPropias(jugador);
            socket.emit("cartaPenalizacion",{carta:{numero:penalizacion.numero,palo:penalizacion.palo,valor:valorCarta(penalizacion)}});
        }
        emitirSala(sala,"saltoDeFeFallido",{jugadorId:jugador.id,jugadorNombre:jugador.nombre});
    });

    socket.on("usarPoder", datos => {
        const sala = salaDeSocket(socket); if (!sala) return;
        const jugador = buscarJugador(sala,socket.id);
        if (!jugador || !esTurno(sala,socket.id) || !jugador.accionEspecial || jugador.accionEspecial.usada) return;
        const tipo = jugador.accionEspecial.tipo;

        if (tipo === "verPropia") {
            const indice=Number(datos?.indice);
            if (!Number.isInteger(indice)||indice<0||indice>=jugador.cartas.length) return;
            jugador.accionEspecial.usada=true;
            const carta=jugador.cartas[indice];
            socket.emit("poderCartaRevelada",{jugador:jugador.id,nombre:jugador.nombre,indice,carta:{numero:carta.numero,palo:carta.palo,valor:valorCarta(carta)}});
            return;
        }

        if (tipo === "verRival") {
            const rival=buscarJugador(sala,datos?.jugadorId); if (!rival||rival.id===jugador.id) return;
            const indice=Number(datos?.indice); if (!Number.isInteger(indice)||indice<0||indice>=rival.cartas.length) return;
            jugador.accionEspecial.usada=true;
            const carta=rival.cartas[indice];
            socket.emit("poderCartaRevelada",{jugador:rival.id,nombre:rival.nombre,indice,carta:{numero:carta.numero,palo:carta.palo,valor:valorCarta(carta)}});
            return;
        }

        if (tipo === "intercambiar") {
            const rival=buscarJugador(sala,datos?.jugadorId); if (!rival||rival.id===jugador.id) return;
            const ip=Number(datos?.indicePropio), ir=Number(datos?.indiceRival);
            if (!Number.isInteger(ip)||ip<0||ip>=jugador.cartas.length||!Number.isInteger(ir)||ir<0||ir>=rival.cartas.length) return;
            const tmp=jugador.cartas[ip]; jugador.cartas[ip]=rival.cartas[ir]; rival.cartas[ir]=tmp;
            jugador.accionEspecial.usada=true;
            const info={jugadorId:jugador.id,jugadorNombre:jugador.nombre,rivalId:rival.id,rivalNombre:rival.nombre,indicePropio:ip,indiceRival:ir};
            emitirSala(sala,"intercambioPreparado",info);
            setTimeout(()=>{
                if (!salas.has(sala.codigo)) return;
                enviarCartasPropias(jugador); enviarCartasPropias(rival); enviarJugadores(sala);
                emitirSala(sala,"intercambioRealizado",info);
            },650);
        }
    });

    socket.on("terminarAccionEspecial", () => {
        const sala=salaDeSocket(socket); if(!sala)return;
        const jugador=buscarJugador(sala,socket.id);
        if(!jugador||!esTurno(sala,socket.id)||!jugador.accionEspecial)return;
        jugador.accionEspecial=null; socket.emit("poderUsado"); pasarTurno(sala);
    });

    socket.on("listoPreparacion", () => {
        const sala=salaDeSocket(socket); if(!sala||!sala.partidaIniciada||!sala.fasePreparacion)return;
        const jugador=buscarJugador(sala,socket.id); if(!jugador)return;
        jugador.listo=true; enviarJugadores(sala);
        emitirSala(sala,"jugadorListo",{jugadorId:jugador.id,jugadorNombre:jugador.nombre});
        if(sala.jugadores.every(j=>j.listo)) finalizarPreparacion(sala);
    });

    socket.on("listoSiguienteRonda", () => {
        const sala=salaDeSocket(socket); if(!sala||!sala.partidaIniciada||!sala.faseEntreRondas)return;
        const jugador=buscarJugador(sala,socket.id); if(!jugador)return;
        jugador.listoEntreRondas=true; enviarJugadores(sala);
        const listos=sala.jugadores.filter(j=>j.listoEntreRondas).length;
        emitirSala(sala,"estadoListosSiguienteRonda",{listos,total:sala.jugadores.length});
        if(sala.jugadores.every(j=>j.listoEntreRondas)) comenzarRonda(sala);
    });

    socket.on("cantarPedro", () => {
        const sala=salaDeSocket(socket); if(!sala||!buscarJugador(sala,socket.id))return;
        cantarPedro(sala,socket);
    });

    socket.on("disconnect", () => {
        const codigo = socket.data.codigoSala;
        const sala = salas.get(codigo);
        if (!sala) return;

        // CRÍTICO: en un disconnect buscamos SOLO por socket.id.
        // localStorage puede compartirse entre pestañas, por lo que usar sessionToken
        // aquí podía marcar como desconectado al jugador equivocado.
        const jugador = sala.jugadores.find(
            j => j.id === socket.id
        );

        if (!jugador) return;

        console.log(
            `[disconnect] sala=${sala.codigo} jugador=${jugador.nombre} socket=${socket.id} reason=${socket.conn?.transport?.name || "desconocido"}`
        );

        jugador.conectado = false;

        if (jugador.temporizadorExpulsion) {
            clearTimeout(jugador.temporizadorExpulsion);
        }

        jugador.temporizadorExpulsion = setTimeout(() => {
            if (!salas.has(sala.codigo)) return;
            if (jugador.conectado) return;
            eliminarJugadorDefinitivamente(sala, jugador);
        }, GRACIA_RECONEXION_MS);

        enviarJugadores(sala);
    });
});

server.listen(PORT,"0.0.0.0",()=>console.log(`Servidor funcionando en http://localhost:${PORT}`));
