const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const MIN_JUGADORES = 2;
const MAX_JUGADORES = 8;
const CARTAS_POR_JUGADOR = 4;

const TIEMPO_DEFAULT = 30;
const TIEMPO_MIN = 10;
const TIEMPO_MAX = 60;

const PUNTAJE_MAXIMO = 200;

let jugadores = [];
let mazo = [];
let cementerio = [];

let partidaIniciada = false;
let fasePreparacion = false;
let faseEntreRondas = false;

let ronda = 0;
let indiceTurno = 0;
let tiempoPorTurno = TIEMPO_DEFAULT;

let temporizadorTurno = null;
let temporizadorPreparacion = null;

/*
    Cada vez que cambia físicamente la carta superior
    del cementerio, cambiamos esta versión.

    Así podemos saber si un jugador ya intentó
    Salto de fe sobre ESA carta concreta.
*/
let versionCementerio = 0;
let intentosSalto = new Set();


// ======================================================
// CARTAS
// ======================================================

function crearMazo() {

    const nuevoMazo = [];

    const palos = [
        "oros",
        "copas",
        "espadas",
        "bastos"
    ];

    for (const palo of palos) {

        for (let numero = 1; numero <= 12; numero++) {

            nuevoMazo.push({
                numero,
                palo,
                viva: true
            });
        }
    }

    return nuevoMazo;
}


function mezclar(array) {

    for (let i = array.length - 1; i > 0; i--) {

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [array[i], array[j]] =
            [array[j], array[i]];
    }
}


function valorCarta(carta) {

    if (!carta) return 0;

    if (
        carta.numero === 12 &&
        carta.palo === "espadas"
    ) {

        return 0;
    }

    return carta.numero;
}


function tipoPoder(numero) {

    if (
        numero === 6 ||
        numero === 7
    ) {

        return "verPropia";
    }

    if (
        numero === 8 ||
        numero === 9
    ) {

        return "verRival";
    }

    if (
        numero === 10 ||
        numero === 11
    ) {

        return "intercambiar";
    }

    return null;
}


// ======================================================
// JUGADORES
// ======================================================

function buscarJugador(id) {

    return jugadores.find(
        jugador =>
            jugador.id === id
    );
}


function esTurno(id) {

    if (!partidaIniciada) return false;
    if (fasePreparacion) return false;
    if (faseEntreRondas) return false;
    if (!jugadores[indiceTurno]) return false;

    return (
        jugadores[indiceTurno].id === id
    );
}


function jugadoresPublicos() {

    return jugadores.map(
        jugador => ({

            id:
                jugador.id,

            nombre:
                jugador.nombre,

            puntos:
                jugador.puntos,

            listo:
                jugador.listo,

            listoEntreRondas:
                jugador.listoEntreRondas,

            cartas:
                jugador.cartas.map(
                    () => ({
                        oculta: true
                    })
                )
        })
    );
}


function enviarJugadores() {

    io.emit(
        "jugadoresActualizados",
        {

            jugadores:
                jugadoresPublicos(),

            partidaIniciada,

            fasePreparacion,

            faseEntreRondas,

            ronda
        }
    );
}


function enviarCartasPropias(jugador) {

    io.to(jugador.id)
        .emit(
            "cartasActuales",
            {

                cartas:
                    jugador.cartas.map(
                        carta => ({

                            numero:
                                carta.numero,

                            palo:
                                carta.palo,

                            valor:
                                valorCarta(carta)
                        })
                    )
            }
        );
}


// ======================================================
// CEMENTERIO
// ======================================================

function nuevaVersionCementerio() {

    versionCementerio++;

    intentosSalto =
        new Set();
}


function cartaSuperiorCementerio() {

    if (
        cementerio.length === 0
    ) {

        return null;
    }

    return cementerio[
        cementerio.length - 1
    ];
}


function enviarCementerio() {

    const carta =
        cartaSuperiorCementerio();

    io.emit(
        "cementerioActualizado",
        {

            carta:
                carta
                    ? {

                        numero:
                            carta.numero,

                        palo:
                            carta.palo,

                        valor:
                            valorCarta(carta),

                        version:
                            versionCementerio
                    }
                    : null
        }
    );
}


function ponerEnCementerio(carta) {

    carta.viva =
        false;

    cementerio.push(
        carta
    );

    nuevaVersionCementerio();

    enviarCementerio();
}


function quitarSuperiorCementerio() {

    if (
        cementerio.length === 0
    ) {

        return null;
    }

    const carta =
        cementerio.pop();

    nuevaVersionCementerio();

    enviarCementerio();

    return carta;
}


function reciclarCementerio() {

    if (
        cementerio.length <= 1
    ) {

        return;
    }

    const superior =
        cementerio.pop();

    while (
        cementerio.length > 0
    ) {

        const carta =
            cementerio.pop();

        carta.viva =
            true;

        mazo.push(
            carta
        );
    }

    cementerio.push(
        superior
    );

    mezclar(mazo);

    enviarCementerio();
}


function sacarDelMazo() {

    if (
        mazo.length === 0
    ) {

        reciclarCementerio();
    }

    if (
        mazo.length === 0
    ) {

        return null;
    }

    return mazo.pop();
}


// ======================================================
// TEMPORIZADORES
// ======================================================

function detenerTemporizadorTurno() {

    if (
        temporizadorTurno
    ) {

        clearTimeout(
            temporizadorTurno
        );

        temporizadorTurno =
            null;
    }
}


function detenerTemporizadorPreparacion() {

    if (
        temporizadorPreparacion
    ) {

        clearTimeout(
            temporizadorPreparacion
        );

        temporizadorPreparacion =
            null;
    }
}


function devolverCartaPendiente(jugador) {

    if (
        !jugador ||
        !jugador.cartaSacada
    ) {

        return;
    }

    /*
        Si venía del cementerio,
        vuelve arriba del cementerio.

        Si venía del mazo,
        vuelve al mazo.
    */

    if (
        jugador.desdeCementerio
    ) {

        ponerEnCementerio(
            jugador.cartaSacada
        );

    } else {

        jugador.cartaSacada.viva =
            true;

        mazo.push(
            jugador.cartaSacada
        );
    }

    jugador.cartaSacada =
        null;

    jugador.desdeCementerio =
        false;
}


function iniciarTemporizadorDeTurno() {

    detenerTemporizadorTurno();

    if (!partidaIniciada) return;
    if (fasePreparacion) return;
    if (faseEntreRondas) return;

    const jugador =
        jugadores[indiceTurno];

    if (!jugador) return;

    io.emit(
        "temporizadorIniciado",
        {

            segundos:
                tiempoPorTurno,

            jugadorId:
                jugador.id
        }
    );

    temporizadorTurno =
        setTimeout(
            () => {

                const actual =
                    jugadores[
                        indiceTurno
                    ];

                if (!actual) return;

                devolverCartaPendiente(
                    actual
                );

                actual.accionEspecial =
                    null;

                io.emit(
                    "turnoAgotado",
                    {

                        jugadorId:
                            actual.id,

                        jugadorNombre:
                            actual.nombre
                    }
                );

                pasarTurno();

            },
            tiempoPorTurno * 1000
        );
}


// ======================================================
// TURNOS
// ======================================================

function enviarTurnoActual() {

    const jugador =
        jugadores[indiceTurno];

    io.emit(
        "turnoActual",
        {

            jugadorId:
                jugador
                    ? jugador.id
                    : null,

            jugadorNombre:
                jugador
                    ? jugador.nombre
                    : ""
        }
    );
}


function pasarTurno() {

    if (!partidaIniciada) return;
    if (fasePreparacion) return;
    if (faseEntreRondas) return;
    if (jugadores.length === 0) return;

    detenerTemporizadorTurno();

    const anterior =
        jugadores[indiceTurno];

    if (anterior) {

        anterior.accionEspecial =
            null;

        devolverCartaPendiente(
            anterior
        );
    }

    indiceTurno++;

    if (
        indiceTurno >=
        jugadores.length
    ) {

        indiceTurno = 0;
    }

    enviarTurnoActual();

    enviarJugadores();

    iniciarTemporizadorDeTurno();
}


// ======================================================
// RONDA
// ======================================================

function repartirCartas() {

    jugadores.forEach(
        jugador => {

            jugador.cartas =
                [];

            jugador.cartaSacada =
                null;

            jugador.desdeCementerio =
                false;

            jugador.accionEspecial =
                null;

            jugador.listo =
                false;

            jugador.listoEntreRondas =
                false;

            for (
                let i = 0;
                i < CARTAS_POR_JUGADOR;
                i++
            ) {

                const carta =
                    sacarDelMazo();

                if (carta) {

                    /*
                        Una carta que entra en mano
                        ya no tiene poder.
                    */

                    carta.viva =
                        false;

                    jugador.cartas.push(
                        carta
                    );
                }
            }

            enviarCartasPropias(
                jugador
            );
        }
    );

    enviarJugadores();
}


function comenzarPreparacion() {

    fasePreparacion =
        true;

    faseEntreRondas =
        false;

    jugadores.forEach(
        jugador => {

            jugador.listo =
                false;

            jugador.listoEntreRondas =
                false;
        }
    );

    io.emit(
        "fasePreparacion",
        {

            segundos:
                tiempoPorTurno
        }
    );

    enviarJugadores();

    detenerTemporizadorPreparacion();

    temporizadorPreparacion =
        setTimeout(
            () => {

                finalizarPreparacion();

            },
            tiempoPorTurno * 1000
        );
}


function finalizarPreparacion() {

    if (
        !fasePreparacion
    ) {

        return;
    }

    detenerTemporizadorPreparacion();

    fasePreparacion =
        false;

    jugadores.forEach(
        jugador => {

            jugador.listo =
                false;
        }
    );

    io.emit(
        "finFasePreparacion"
    );

    indiceTurno = 0;

    enviarJugadores();

    enviarTurnoActual();

    iniciarTemporizadorDeTurno();
}


function comenzarRonda() {

    detenerTemporizadorTurno();

    detenerTemporizadorPreparacion();

    faseEntreRondas =
        false;

    mazo =
        crearMazo();

    mezclar(mazo);

    cementerio =
        [];

    nuevaVersionCementerio();

    ronda++;

    io.emit(
        "nuevaRonda",
        {
            ronda
        }
    );

    enviarCementerio();

    repartirCartas();

    comenzarPreparacion();
}


// ======================================================
// PEDRO
// ======================================================

function cantarPedro(socket) {

    if (!partidaIniciada) return;

    if (faseEntreRondas) return;

    detenerTemporizadorTurno();

    detenerTemporizadorPreparacion();

    fasePreparacion =
        false;

    jugadores.forEach(
        jugador => {

            devolverCartaPendiente(
                jugador
            );

            jugador.accionEspecial =
                null;

            jugador.listoEntreRondas =
                false;
        }
    );

    const resultados =
        [];

    for (
        const jugador of jugadores
    ) {

        const puntosRonda =
            jugador.cartas.reduce(
                (suma, carta) =>
                    suma +
                    valorCarta(carta),
                0
            );

        jugador.puntos +=
            puntosRonda;

        resultados.push({

            id:
                jugador.id,

            nombre:
                jugador.nombre,

            cartas:
                jugador.cartas.map(
                    carta => ({

                        numero:
                            carta.numero,

                        palo:
                            carta.palo,

                        valor:
                            valorCarta(carta)
                    })
                ),

            puntosRonda,

            puntosTotales:
                jugador.puntos
        });
    }

    const llamador =
        buscarJugador(
            socket.id
        );

    const alguienLlegoA200 =
        jugadores.some(
            jugador =>
                jugador.puntos >=
                PUNTAJE_MAXIMO
        );

    io.emit(
        "rondaTerminada",
        {

            ronda,

            resultados,

            hayFinal:
                alguienLlegoA200,

            llamadoPor: {

                id:
                    socket.id,

                nombre:
                    llamador
                        ? llamador.nombre
                        : "Jugador"
            }
        }
    );

    if (
        alguienLlegoA200
    ) {

        partidaIniciada =
            false;

        faseEntreRondas =
            false;

        const ranking =
            [...jugadores].sort(
                (a, b) =>
                    a.puntos -
                    b.puntos
            );

        io.emit(
            "partidaTerminada",
            {

                jugadores:
                    ranking.map(
                        jugador => ({

                            id:
                                jugador.id,

                            nombre:
                                jugador.nombre,

                            puntos:
                                jugador.puntos
                        })
                    ),

                ganador:
                    ranking[0]
                        ? {

                            id:
                                ranking[0].id,

                            nombre:
                                ranking[0].nombre,

                            puntos:
                                ranking[0].puntos
                        }
                        : null
            }
        );

        enviarJugadores();

        return;
    }

    /*
        YA NO ARRANCA AUTOMÁTICAMENTE.

        Ahora todos tienen que tocar LISTO.
    */

    faseEntreRondas =
        true;

    enviarJugadores();

    io.emit(
        "esperandoSiguienteRonda",
        {

            listos: 0,

            total:
                jugadores.length
        }
    );
}


// ======================================================
// SOCKET
// ======================================================

io.on(
    "connection",
    socket => {

        console.log(
            "Jugador conectado:",
            socket.id
        );


        socket.emit(
            "estadoInicial",
            {

                jugadores:
                    jugadoresPublicos(),

                partidaIniciada,

                fasePreparacion,

                faseEntreRondas,

                ronda,

                tiempoPorTurno
            }
        );


        // ==================================================
        // ENTRAR
        // ==================================================

        socket.on(
            "entrarPartida",
            nombre => {

                if (
                    partidaIniciada
                ) {

                    socket.emit(
                        "errorJuego",
                        "La partida ya comenzó."
                    );

                    return;
                }

                if (
                    jugadores.length >=
                    MAX_JUGADORES
                ) {

                    socket.emit(
                        "errorJuego",
                        "La partida está llena."
                    );

                    return;
                }

                const nombreLimpio =
                    String(
                        nombre || ""
                    ).trim();

                if (!nombreLimpio) {

                    socket.emit(
                        "errorJuego",
                        "Escribí tu nombre."
                    );

                    return;
                }

                if (
                    nombreLimpio.length >
                    18
                ) {

                    socket.emit(
                        "errorJuego",
                        "El nombre puede tener como máximo 18 caracteres."
                    );

                    return;
                }

                const repetido =
                    jugadores.some(
                        jugador =>
                            jugador.nombre
                                .toLowerCase() ===
                            nombreLimpio
                                .toLowerCase()
                    );

                if (repetido) {

                    socket.emit(
                        "errorJuego",
                        "Ya hay un jugador con ese nombre."
                    );

                    return;
                }

                jugadores.push({

                    id:
                        socket.id,

                    nombre:
                        nombreLimpio,

                    cartas:
                        [],

                    puntos:
                        0,

                    cartaSacada:
                        null,

                    desdeCementerio:
                        false,

                    accionEspecial:
                        null,

                    listo:
                        false,

                    listoEntreRondas:
                        false
                });

                socket.emit(
                    "entradaConfirmada",
                    {

                        id:
                            socket.id,

                        nombre:
                            nombreLimpio
                    }
                );

                enviarJugadores();
            }
        );


        // ==================================================
        // INICIAR
        // ==================================================

        socket.on(
            "iniciarPartida",
            segundos => {

                if (
                    partidaIniciada
                ) {

                    return;
                }

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;

                if (
                    jugadores.length <
                    MIN_JUGADORES
                ) {

                    socket.emit(
                        "errorJuego",
                        "Se necesitan al menos 2 jugadores."
                    );

                    return;
                }

                let tiempo =
                    Number(segundos);

                if (
                    !Number.isFinite(
                        tiempo
                    )
                ) {

                    tiempo =
                        TIEMPO_DEFAULT;
                }

                tiempo =
                    Math.round(
                        tiempo
                    );

                tiempo =
                    Math.max(
                        TIEMPO_MIN,
                        Math.min(
                            TIEMPO_MAX,
                            tiempo
                        )
                    );

                tiempoPorTurno =
                    tiempo;

                partidaIniciada =
                    true;

                faseEntreRondas =
                    false;

                ronda = 0;

                jugadores.forEach(
                    jugador => {

                        jugador.puntos =
                            0;

                        jugador.listoEntreRondas =
                            false;
                    }
                );

                io.emit(
                    "partidaIniciada",
                    {
                        tiempoPorTurno
                    }
                );

                comenzarRonda();
            }
        );


        // ==================================================
        // SACAR MAZO
        // ==================================================

        socket.on(
            "sacarCarta",
            () => {

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;
                if (!esTurno(socket.id)) return;
                if (jugador.cartaSacada) return;
                if (jugador.accionEspecial) return;

                const carta =
                    sacarDelMazo();

                if (!carta) return;

                jugador.cartaSacada =
                    carta;

                jugador.desdeCementerio =
                    false;

                socket.emit(
                    "cartaSacada",
                    {

                        carta: {

                            numero:
                                carta.numero,

                            palo:
                                carta.palo,

                            valor:
                                valorCarta(carta),

                            viva:
                                true
                        }
                    }
                );
            }
        );


        // ==================================================
        // CLIC CEMENTERIO
        // ==================================================

        socket.on(
            "sacarDelCementerio",
            () => {

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;
                if (!esTurno(socket.id)) return;
                if (jugador.cartaSacada) return;
                if (jugador.accionEspecial) return;

                const carta =
                    quitarSuperiorCementerio();

                if (!carta) {

                    socket.emit(
                        "errorJuego",
                        "El cementerio está vacío."
                    );

                    return;
                }

                carta.viva =
                    false;

                jugador.cartaSacada =
                    carta;

                jugador.desdeCementerio =
                    true;

                socket.emit(
                    "cartaSacada",
                    {

                        carta: {

                            numero:
                                carta.numero,

                            palo:
                                carta.palo,

                            valor:
                                valorCarta(carta),

                            viva:
                                false
                        }
                    }
                );
            }
        );


        // ==================================================
        // ARRASTRAR CEMENTERIO A MANO
        // ==================================================

        socket.on(
            "tomarCementerioYReemplazar",
            indice => {

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;
                if (!esTurno(socket.id)) return;
                if (jugador.cartaSacada) return;
                if (jugador.accionEspecial) return;

                const i =
                    Number(indice);

                if (
                    !Number.isInteger(i) ||
                    i < 0 ||
                    i >=
                        jugador.cartas.length
                ) {

                    return;
                }

                const tomada =
                    quitarSuperiorCementerio();

                if (!tomada) return;

                tomada.viva =
                    false;

                const vieja =
                    jugador.cartas[i];

                vieja.viva =
                    false;

                jugador.cartas[i] =
                    tomada;

                ponerEnCementerio(
                    vieja
                );

                enviarCartasPropias(
                    jugador
                );

                io.emit(
                    "cartaReemplazada",
                    {

                        jugadorId:
                            jugador.id,

                        jugadorNombre:
                            jugador.nombre,

                        numero:
                            vieja.numero
                    }
                );

                pasarTurno();
            }
        );


        // ==================================================
        // DESCARTAR CARTA SACADA
        // ==================================================

        socket.on(
            "tirarAlCementerio",
            () => {

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;
                if (!esTurno(socket.id)) return;
                if (!jugador.cartaSacada) return;

                const carta =
                    jugador.cartaSacada;

                const poder =
                    !jugador.desdeCementerio &&
                    carta.viva === true
                        ? tipoPoder(
                            carta.numero
                        )
                        : null;

                jugador.cartaSacada =
                    null;

                jugador.desdeCementerio =
                    false;

                ponerEnCementerio(
                    carta
                );

                io.emit(
                    "cartaDescartada",
                    {

                        jugadorId:
                            jugador.id,

                        jugadorNombre:
                            jugador.nombre,

                        numero:
                            carta.numero,

                        palo:
                            carta.palo
                    }
                );

                if (poder) {

                    jugador.accionEspecial =
                        {

                            tipo:
                                poder,

                            numero:
                                carta.numero,

                            usada:
                                false
                        };

                    socket.emit(
                        "poderDisponible",
                        {

                            tipo:
                                poder,

                            numero:
                                carta.numero
                        }
                    );

                    iniciarTemporizadorDeTurno();

                    return;
                }

                pasarTurno();
            }
        );


        // ==================================================
        // REEMPLAZAR
        // ==================================================

        socket.on(
            "reemplazarCarta",
            indice => {

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;
                if (!esTurno(socket.id)) return;
                if (!jugador.cartaSacada) return;

                const i =
                    Number(indice);

                if (
                    !Number.isInteger(i) ||
                    i < 0 ||
                    i >=
                        jugador.cartas.length
                ) {

                    return;
                }

                const nueva =
                    jugador.cartaSacada;

                const vieja =
                    jugador.cartas[i];

                jugador.cartaSacada =
                    null;

                jugador.desdeCementerio =
                    false;

                nueva.viva =
                    false;

                vieja.viva =
                    false;

                jugador.cartas[i] =
                    nueva;

                ponerEnCementerio(
                    vieja
                );

                enviarCartasPropias(
                    jugador
                );

                io.emit(
                    "cartaReemplazada",
                    {

                        jugadorId:
                            jugador.id,

                        jugadorNombre:
                            jugador.nombre,

                        numero:
                            vieja.numero
                    }
                );

                pasarTurno();
            }
        );


        // ==================================================
        // SALTO DE FE
        // ==================================================

        socket.on(
            "intentarSaltoDeFe",
            indice => {

                if (!partidaIniciada) return;
                if (fasePreparacion) return;
                if (faseEntreRondas) return;

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;

                const superior =
                    cartaSuperiorCementerio();

                if (!superior) {

                    socket.emit(
                        "errorJuego",
                        "No hay ninguna carta en el cementerio."
                    );

                    return;
                }

                const claveIntento =
                    `${versionCementerio}:${jugador.id}`;

                if (
                    intentosSalto.has(
                        claveIntento
                    )
                ) {

                    socket.emit(
                        "errorJuego",
                        "Ya intentaste sobre esta carta del cementerio."
                    );

                    return;
                }

                const i =
                    Number(indice);

                if (
                    !Number.isInteger(i) ||
                    i < 0 ||
                    i >=
                        jugador.cartas.length
                ) {

                    return;
                }

                intentosSalto.add(
                    claveIntento
                );

                const carta =
                    jugador.cartas[i];

                /*
                    LA COMPARACIÓN SE HACE AHORA.

                    Si mientras arrastrabas el otro jugador
                    cambió la carta superior, se compara
                    contra la nueva carta.
                */

                if (
                    carta.numero ===
                    superior.numero
                ) {

                    jugador.cartas.splice(
                        i,
                        1
                    );

                    carta.viva =
                        false;

                    /*
                        Se pone otro 5 arriba del 5, por ejemplo.

                        Sigue habiendo un 5 arriba,
                        pero es una carta NUEVA.

                        Por eso otros jugadores pueden
                        seguir encadenando Saltos de fe.
                    */

                    ponerEnCementerio(
                        carta
                    );

                    enviarCartasPropias(
                        jugador
                    );

                    io.emit(
                        "saltoDeFeAcertado",
                        {

                            jugadorId:
                                jugador.id,

                            jugadorNombre:
                                jugador.nombre,

                            numero:
                                carta.numero
                        }
                    );

                    return;
                }


                /*
                    FALLÓ
                */

                const penalizacion =
                    sacarDelMazo();

                if (penalizacion) {

                    penalizacion.viva =
                        false;

                    jugador.cartas.push(
                        penalizacion
                    );

                    enviarCartasPropias(
                        jugador
                    );

                    socket.emit(
                        "cartaPenalizacion",
                        {

                            carta: {

                                numero:
                                    penalizacion.numero,

                                palo:
                                    penalizacion.palo,

                                valor:
                                    valorCarta(
                                        penalizacion
                                    )
                            }
                        }
                    );
                }

                io.emit(
                    "saltoDeFeFallido",
                    {

                        jugadorId:
                            jugador.id,

                        jugadorNombre:
                            jugador.nombre
                    }
                );
            }
        );


        // ==================================================
        // PODERES
        // ==================================================

        socket.on(
            "usarPoder",
            datos => {

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;
                if (!esTurno(socket.id)) return;
                if (!jugador.accionEspecial) return;
                if (jugador.accionEspecial.usada) return;

                const tipo =
                    jugador
                        .accionEspecial
                        .tipo;


                // 6 / 7

                if (
                    tipo ===
                    "verPropia"
                ) {

                    const indice =
                        Number(
                            datos?.indice
                        );

                    if (
                        !Number.isInteger(indice) ||
                        indice < 0 ||
                        indice >=
                            jugador.cartas.length
                    ) {

                        return;
                    }

                    jugador
                        .accionEspecial
                        .usada =
                        true;

                    const carta =
                        jugador.cartas[
                            indice
                        ];

                    socket.emit(
                        "poderCartaRevelada",
                        {

                            jugador:
                                jugador.id,

                            nombre:
                                jugador.nombre,

                            indice,

                            carta: {

                                numero:
                                    carta.numero,

                                palo:
                                    carta.palo,

                                valor:
                                    valorCarta(carta)
                            }
                        }
                    );

                    return;
                }


                // 8 / 9

                if (
                    tipo ===
                    "verRival"
                ) {

                    const rival =
                        buscarJugador(
                            datos?.jugadorId
                        );

                    if (!rival) return;

                    if (
                        rival.id ===
                        jugador.id
                    ) {

                        return;
                    }

                    const indice =
                        Number(
                            datos?.indice
                        );

                    if (
                        !Number.isInteger(indice) ||
                        indice < 0 ||
                        indice >=
                            rival.cartas.length
                    ) {

                        return;
                    }

                    jugador
                        .accionEspecial
                        .usada =
                        true;

                    const carta =
                        rival.cartas[
                            indice
                        ];

                    socket.emit(
                        "poderCartaRevelada",
                        {

                            jugador:
                                rival.id,

                            nombre:
                                rival.nombre,

                            indice,

                            carta: {

                                numero:
                                    carta.numero,

                                palo:
                                    carta.palo,

                                valor:
                                    valorCarta(carta)
                            }
                        }
                    );

                    return;
                }


                // 10 / 11

                if (
                    tipo ===
                    "intercambiar"
                ) {

                    const rival =
                        buscarJugador(
                            datos?.jugadorId
                        );

                    if (!rival) return;

                    if (
                        rival.id ===
                        jugador.id
                    ) {

                        return;
                    }

                    const indicePropio =
                        Number(
                            datos?.indicePropio
                        );

                    const indiceRival =
                        Number(
                            datos?.indiceRival
                        );

                    if (
                        !Number.isInteger(indicePropio) ||
                        indicePropio < 0 ||
                        indicePropio >=
                            jugador.cartas.length
                    ) {

                        return;
                    }

                    if (
                        !Number.isInteger(indiceRival) ||
                        indiceRival < 0 ||
                        indiceRival >=
                            rival.cartas.length
                    ) {

                        return;
                    }

                    const temporal =
                        jugador.cartas[
                            indicePropio
                        ];

                    jugador.cartas[
                        indicePropio
                    ] =
                        rival.cartas[
                            indiceRival
                        ];

                    rival.cartas[
                        indiceRival
                    ] =
                        temporal;

                    jugador
                        .accionEspecial
                        .usada =
                        true;

                    enviarCartasPropias(
                        jugador
                    );

                    enviarCartasPropias(
                        rival
                    );

                    enviarJugadores();

                    io.emit(
                        "intercambioRealizado",
                        {

                            jugadorId:
                                jugador.id,

                            jugadorNombre:
                                jugador.nombre,

                            rivalId:
                                rival.id,

                            rivalNombre:
                                rival.nombre
                        }
                    );
                }
            }
        );


        socket.on(
            "terminarAccionEspecial",
            () => {

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;
                if (!esTurno(socket.id)) return;
                if (!jugador.accionEspecial) return;

                jugador.accionEspecial =
                    null;

                socket.emit(
                    "poderUsado"
                );

                pasarTurno();
            }
        );


        // ==================================================
        // LISTO PREPARACIÓN
        // ==================================================

        socket.on(
            "listoPreparacion",
            () => {

                if (!partidaIniciada) return;
                if (!fasePreparacion) return;

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;

                jugador.listo =
                    true;

                enviarJugadores();

                io.emit(
                    "jugadorListo",
                    {

                        jugadorId:
                            jugador.id,

                        jugadorNombre:
                            jugador.nombre
                    }
                );

                const todos =
                    jugadores.every(
                        jugador =>
                            jugador.listo
                    );

                if (todos) {

                    finalizarPreparacion();
                }
            }
        );


        // ==================================================
        // LISTO ENTRE RONDAS
        // ==================================================

        socket.on(
            "listoSiguienteRonda",
            () => {

                if (!partidaIniciada) return;
                if (!faseEntreRondas) return;

                const jugador =
                    buscarJugador(
                        socket.id
                    );

                if (!jugador) return;

                jugador.listoEntreRondas =
                    true;

                enviarJugadores();

                const listos =
                    jugadores.filter(
                        jugador =>
                            jugador
                                .listoEntreRondas
                    ).length;

                io.emit(
                    "estadoListosSiguienteRonda",
                    {

                        listos,

                        total:
                            jugadores.length
                    }
                );

                const todos =
                    jugadores.every(
                        jugador =>
                            jugador
                                .listoEntreRondas
                    );

                if (todos) {

                    comenzarRonda();
                }
            }
        );


        // ==================================================
        // PEDRO
        // ==================================================

        socket.on(
            "cantarPedro",
            () => {

                if (
                    !buscarJugador(
                        socket.id
                    )
                ) {

                    return;
                }

                cantarPedro(
                    socket
                );
            }
        );


        // ==================================================
        // DESCONECTAR
        // ==================================================

        socket.on(
            "disconnect",
            () => {

                const estaba =
                    buscarJugador(
                        socket.id
                    );

                if (!estaba) return;

                jugadores =
                    jugadores.filter(
                        jugador =>
                            jugador.id !==
                            socket.id
                    );

                if (
                    jugadores.length === 0
                ) {

                    partidaIniciada =
                        false;

                    fasePreparacion =
                        false;

                    faseEntreRondas =
                        false;

                    ronda = 0;
                    indiceTurno = 0;

                    mazo = [];
                    cementerio = [];

                    detenerTemporizadorTurno();
                    detenerTemporizadorPreparacion();

                    return;
                }

                if (
                    partidaIniciada &&
                    jugadores.length <
                    MIN_JUGADORES
                ) {

                    partidaIniciada =
                        false;

                    fasePreparacion =
                        false;

                    faseEntreRondas =
                        false;

                    ronda = 0;

                    detenerTemporizadorTurno();
                    detenerTemporizadorPreparacion();

                    jugadores.forEach(
                        jugador => {

                            jugador.cartas =
                                [];

                            jugador.cartaSacada =
                                null;

                            jugador.accionEspecial =
                                null;

                            jugador.listo =
                                false;

                            jugador.listoEntreRondas =
                                false;
                        }
                    );

                    io.emit(
                        "partidaReiniciada",
                        {

                            motivo:
                                "No quedan suficientes jugadores para continuar."
                        }
                    );
                }

                if (
                    indiceTurno >=
                    jugadores.length
                ) {

                    indiceTurno = 0;
                }

                /*
                    Si alguien se fue mientras
                    todos estaban esperando la próxima ronda,
                    revisamos nuevamente.
                */

                if (
                    partidaIniciada &&
                    faseEntreRondas &&
                    jugadores.every(
                        jugador =>
                            jugador.listoEntreRondas
                    )
                ) {

                    comenzarRonda();

                    return;
                }

                enviarJugadores();

                if (
                    partidaIniciada &&
                    !faseEntreRondas &&
                    !fasePreparacion
                ) {

                    enviarTurnoActual();

                    iniciarTemporizadorDeTurno();
                }
            }
        );
    }
);


server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Servidor funcionando en http://localhost:${PORT}`
        );
    }
);