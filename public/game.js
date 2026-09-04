const socket = io();

const $ = id =>
    document.getElementById(id);


// ======================================================
// ESTADO
// ======================================================

let miId = null;
let miNombre = "";

let jugadores = [];
let misCartas = [];

let partidaIniciada = false;
let fasePreparacion = false;
let faseEntreRondas = false;

let miTurno = false;

let cartaSacada = null;
let indiceReemplazo = null;

let accionEspecial = null;
let indicePropioIntercambio = null;

let cartaCementerioActual = null;

let cartasMiradasPreparacion =
    new Set();

let intervaloTurno = null;
let intervaloPreparacion = null;


// ======================================================
// ARRASTRE
// ======================================================

let arrastre = null;
let fantasmaArrastre = null;

let bloquearClickHasta = 0;

const DISTANCIA_MINIMA_ARRASTRE =
    10;


// ======================================================
// CARTAS
// ======================================================

const simbolos = {

    oros: "🪙",

    copas: "🏆",

    espadas: "⚔",

    bastos: "🪵"
};


function escapar(texto) {

    return String(texto)

        .replaceAll("&", "&amp;")

        .replaceAll("<", "&lt;")

        .replaceAll(">", "&gt;")

        .replaceAll('"', "&quot;")

        .replaceAll("'", "&#039;");
}


function simboloCarta(carta) {

    return simbolos[
        carta.palo
    ] || "?";
}


function crearCartaOculta(
    indice,
    jugadorId = ""
) {

    const carta =
        document.createElement(
            "button"
        );

    carta.className =
        "carta carta-oculta";

    carta.dataset.indice =
        indice;

    carta.dataset.jugadorId =
        jugadorId;

    carta.innerHTML = `

        <span class="dorso">
            P
        </span>

        <small>
            ${indice + 1}
        </small>

    `;

    return carta;
}


function mostrarValorEnCarta(
    elemento,
    carta
) {

    elemento.className =
        `carta carta-visible carta-espanola palo-${carta.palo}`;

    elemento.dataset.indice =
        elemento.dataset.indice ?? "";

    let dibujo = "";

    /*
        Generamos varios símbolos para que
        la carta recuerde visualmente a una
        baraja española real.
    */

    const cantidad =
        Math.min(
            carta.numero,
            7
        );


    if (
        carta.numero <= 7
    ) {

        dibujo = `
            <div class="figuras-carta">
                ${
                    Array.from(
                        {
                            length:
                                cantidad
                        }
                    )
                    .map(
                        () =>
                            `<span>${simboloCarta(carta)}</span>`
                    )
                    .join("")
                }
            </div>
        `;

    } else {

        /*
            8, 9, 10, 11 y 12:
            usamos una figura grande en el centro.
        */

        dibujo = `

            <div class="figura-grande">

                <span class="simbolo-figura">
                    ${simboloCarta(carta)}
                </span>

                <span class="numero-figura">
                    ${carta.numero}
                </span>

            </div>

        `;
    }


    elemento.innerHTML = `

        <div class="esquina-carta esquina-superior">

            <strong>
                ${carta.numero}
            </strong>

            <span>
                ${simboloCarta(carta)}
            </span>

        </div>


        ${dibujo}


        <div class="esquina-carta esquina-inferior">

            <strong>
                ${carta.numero}
            </strong>

            <span>
                ${simboloCarta(carta)}
            </span>

        </div>


        ${
            carta.numero === 12 &&
            carta.palo === "espadas"

                ? `
                    <div class="carta-cero">
                        0 puntos
                    </div>
                `

                : ""
        }

    `;
}


function volverAOcultarCarta(
    elemento
) {

    const indice =
        Number(
            elemento.dataset.indice
        );

    elemento.className =
        "carta carta-oculta";

    elemento.innerHTML = `

        <span class="dorso">
            P
        </span>

        <small>
            ${indice + 1}
        </small>

    `;
}


function revelarTemporalmente(
    elemento,
    carta,
    duracion = 4000
) {

    mostrarValorEnCarta(
        elemento,
        carta
    );

    setTimeout(
        () => {

            volverAOcultarCarta(
                elemento
            );

        },
        duracion
    );
}


// ======================================================
// MENSAJES
// ======================================================

function mostrarMensaje(
    mensaje,
    duracion = 2500
) {

    const elemento =
        $("mensajeFlotante");

    elemento.textContent =
        mensaje;

    elemento.classList.add(
        "visible"
    );

    clearTimeout(
        mostrarMensaje.timer
    );

    mostrarMensaje.timer =
        setTimeout(
            () => {

                elemento.classList.remove(
                    "visible"
                );

            },
            duracion
        );
}
function abrirReglas() {

    $("panelReglas")
        .classList.remove(
            "oculto"
        );
}


function cerrarReglas() {

    $("panelReglas")
        .classList.add(
            "oculto"
        );
}

function estado(mensaje) {

    $("estadoJuego")
        .textContent =
        mensaje;
}


// ======================================================
// LOBBY
// ======================================================

function renderizarLobby() {

    $("cantidadJugadores")
        .textContent =
        jugadores.length;

    $("jugadoresLobby")
        .innerHTML =
        "";

    jugadores.forEach(
        (jugador, indice) => {

            const fila =
                document.createElement(
                    "div"
                );

            fila.className =
                "jugador-lobby";

            fila.innerHTML = `

                <span>
                    ${indice + 1}.
                    ${escapar(jugador.nombre)}
                </span>

                ${
                    jugador.id === miId
                        ? "<strong>Vos</strong>"
                        : ""
                }

            `;

            $("jugadoresLobby")
                .appendChild(
                    fila
                );
        }
    );

    const estoyDentro =
        jugadores.some(
            jugador =>
                jugador.id === miId
        );

    const puedeIniciar =
        estoyDentro &&
        !partidaIniciada &&
        jugadores.length >= 2;

    $("btnIniciar").disabled =
        !puedeIniciar;

    if (!estoyDentro) {

        $("mensajeLobby")
            .textContent =
            "Entrá con tu nombre.";

    } else if (
        jugadores.length < 2
    ) {

        $("mensajeLobby")
            .textContent =
            "Esperando otro jugador...";

    } else {

        $("mensajeLobby")
            .textContent =
            "Ya pueden iniciar la partida.";
    }
}


// ======================================================
// MARCADOR
// ======================================================

function renderizarMarcador() {

    const orden =
        [...jugadores].sort(
            (a, b) =>
                a.puntos -
                b.puntos
        );

    $("marcador")
        .innerHTML =
        orden.map(
            jugador => `

                <div
                    class="
                        fila-marcador
                        ${
                            jugador.id === miId
                                ? "yo"
                                : ""
                        }
                    "
                >

                    <span>
                        ${escapar(jugador.nombre)}
                    </span>

                    <strong>
                        ${jugador.puntos}
                    </strong>

                </div>

            `
        ).join("");
}


// ======================================================
// RIVALES
// ======================================================

function renderizarJugadoresMesa() {

    const contenedor =
        $("jugadoresMesa");

    contenedor.innerHTML =
        "";

    jugadores.forEach(
        jugador => {

            if (
                jugador.id === miId
            ) {

                return;
            }

            const caja =
                document.createElement(
                    "article"
                );

            caja.className =
                "jugador-mesa";

            const titulo =
                document.createElement(
                    "div"
                );

            titulo.className =
                "nombre-jugador-mesa";

            titulo.innerHTML = `

                <strong>
                    ${escapar(jugador.nombre)}
                </strong>

                <span>
                    ${jugador.puntos} pts
                </span>

            `;

            const zonaCartas =
                document.createElement(
                    "div"
                );

            zonaCartas.className =
                "cartas-rival";

            jugador.cartas.forEach(
                (_, indice) => {

                    const carta =
                        crearCartaOculta(
                            indice,
                            jugador.id
                        );

                    carta.classList.add(
                        "carta-rival"
                    );

                    carta.addEventListener(
                        "click",
                        () => {

                            clickCartaRival(
                                jugador.id,
                                indice,
                                carta
                            );
                        }
                    );

                    zonaCartas.appendChild(
                        carta
                    );
                }
            );

            caja.appendChild(
                titulo
            );

            caja.appendChild(
                zonaCartas
            );

            contenedor.appendChild(
                caja
            );
        }
    );

    actualizarSeleccionables();
}


// ======================================================
// CARTAS PROPIAS
// ======================================================

function renderizarCartasPropias() {

    const contenedor =
        $("cartas");

    contenedor.innerHTML =
        "";

    misCartas.forEach(
        (carta, indice) => {

            const elemento =
                crearCartaOculta(
                    indice,
                    miId
                );

            elemento.classList.add(
                "carta-propia"
            );

            /*
                Salto de fe:
                cualquier carta propia puede empezar
                un arrastre siempre que haya
                una carta arriba del cementerio.
            */

            elemento.addEventListener(
                "pointerdown",
                evento => {

                    comenzarPosibleArrastreCartaPropia(
                        evento,
                        indice,
                        elemento
                    );
                }
            );

            elemento.addEventListener(
                "click",
                evento => {

                    if (
                        Date.now() <
                        bloquearClickHasta
                    ) {

                        evento.preventDefault();

                        return;
                    }

                    clickCartaPropia(
                        indice,
                        elemento
                    );
                }
            );

            contenedor.appendChild(
                elemento
            );
        }
    );

    actualizarSeleccionables();
}


// ======================================================
// PREPARACIÓN
// ======================================================

function renderizarCartasPreparacion() {

    const contenedor =
        $("cartasPreparacion");

    contenedor.innerHTML =
        "";

    misCartas.forEach(
        (carta, indice) => {

            const elemento =
                crearCartaOculta(
                    indice,
                    miId
                );

            elemento.classList.add(
                "carta-preparacion"
            );

            if (
                cartasMiradasPreparacion
                    .has(indice)
            ) {

                mostrarValorEnCarta(
                    elemento,
                    carta
                );

                elemento.dataset.indice =
                    indice;

                elemento.classList.add(
                    "carta-preparacion-abierta"
                );
            }

            elemento.addEventListener(
                "click",
                () => {

                    mirarCartaPreparacion(
                        indice,
                        elemento
                    );
                }
            );

            contenedor.appendChild(
                elemento
            );
        }
    );
}


function mirarCartaPreparacion(
    indice,
    elemento
) {

    if (!fasePreparacion) return;

    if (
        cartasMiradasPreparacion
            .has(indice)
    ) {

        return;
    }

    if (
        cartasMiradasPreparacion
            .size >= 2
    ) {

        return;
    }

    const carta =
        misCartas[indice];

    if (!carta) return;

    /*
        CAMBIO:

        Ya no se esconde la primera.

        La primera queda visible,
        tocás la segunda,
        y quedan LAS DOS VISIBLES
        simultáneamente.
    */

    cartasMiradasPreparacion.add(
        indice
    );

    mostrarValorEnCarta(
        elemento,
        carta
    );

    elemento.dataset.indice =
        indice;

    elemento.classList.add(
        "carta-preparacion-abierta"
    );

    $("contadorPreparacion")
        .textContent =
        `Miraste ${cartasMiradasPreparacion.size}/2`;

    if (
        cartasMiradasPreparacion
            .size === 1
    ) {

        $("preparacionMensaje")
            .textContent =
            "Ahora elegí la segunda carta.";

    } else {

        $("preparacionMensaje")
            .textContent =
            "Estas son tus dos cartas. Memorizá sus posiciones y tocá LISTO cuando quieras.";
    }
}


// ======================================================
// CLICK PROPIA
// ======================================================

function clickCartaPropia(
    indice,
    elemento
) {

    /*
        Salto de fe NO utiliza clic.
        Solo arrastre.
    */


    // CARTA SACADA

    if (
        cartaSacada &&
        miTurno
    ) {

        indiceReemplazo =
            indice;

        document
            .querySelectorAll(
                "#cartas .carta"
            )
            .forEach(
                carta => {

                    carta.classList.remove(
                        "seleccionada"
                    );
                }
            );

        elemento.classList.add(
            "seleccionada"
        );

        mostrarMensaje(
            `Vas a reemplazar la carta ${indice + 1}.`
        );

        return;
    }


    // 6 / 7

    if (
        accionEspecial &&
        accionEspecial.tipo ===
            "verPropia" &&
        miTurno
    ) {

        socket.emit(
            "usarPoder",
            {
                indice
            }
        );

        return;
    }


    // 10 / 11

    if (
        accionEspecial &&
        accionEspecial.tipo ===
            "intercambiar" &&
        miTurno
    ) {

        indicePropioIntercambio =
            indice;

        document
            .querySelectorAll(
                "#cartas .carta"
            )
            .forEach(
                carta => {

                    carta.classList.remove(
                        "seleccionada"
                    );
                }
            );

        elemento.classList.add(
            "seleccionada"
        );

        mostrarMensaje(
            "Ahora elegí una carta de un rival."
        );

        actualizarSeleccionables();

        return;
    }
}


// ======================================================
// CLICK RIVAL
// ======================================================

function clickCartaRival(
    jugadorId,
    indice,
    elemento
) {

    if (!accionEspecial) return;
    if (!miTurno) return;


    if (
        accionEspecial.tipo ===
        "verRival"
    ) {

        socket.emit(
            "usarPoder",
            {

                jugadorId,

                indice
            }
        );

        return;
    }


    if (
        accionEspecial.tipo ===
        "intercambiar"
    ) {

        if (
            indicePropioIntercambio ===
            null
        ) {

            mostrarMensaje(
                "Primero elegí una de tus cartas."
            );

            return;
        }

        socket.emit(
            "usarPoder",
            {

                jugadorId,

                indicePropio:
                    indicePropioIntercambio,

                indiceRival:
                    indice
            }
        );

        elemento.classList.add(
            "seleccionada"
        );
    }
}


// ======================================================
// ARRASTRAR CARTA PROPIA
// ======================================================

function comenzarPosibleArrastreCartaPropia(
    evento,
    indice,
    elemento
) {

    /*
        CAMBIO FUNDAMENTAL:

        NO IMPORTA DE QUIÉN SEA EL TURNO.

        Si hay una carta arriba del cementerio,
        podés intentar un Salto de fe.
    */

    if (!partidaIniciada) return;
    if (fasePreparacion) return;
    if (faseEntreRondas) return;

    if (
        !cartaCementerioActual
    ) {

        return;
    }

    arrastre = {

        tipo:
            "salto",

        indice,

        elemento,

        inicioX:
            evento.clientX,

        inicioY:
            evento.clientY,

        activo:
            false
    };

    iniciarSeguimientoArrastre();
}


// ======================================================
// ARRASTRAR CEMENTERIO
// ======================================================

function comenzarPosibleArrastreCementerio(
    evento
) {

    if (!miTurno) return;

    if (fasePreparacion) return;
    if (faseEntreRondas) return;

    if (cartaSacada) return;
    if (accionEspecial) return;

    if (
        !cartaCementerioActual
    ) {

        return;
    }

    arrastre = {

        tipo:
            "cementerio",

        elemento:
            $("cementerio"),

        inicioX:
            evento.clientX,

        inicioY:
            evento.clientY,

        activo:
            false
    };

    iniciarSeguimientoArrastre();
}


// ======================================================
// SEGUIMIENTO ARRASTRE
// ======================================================

function iniciarSeguimientoArrastre() {

    document.addEventListener(
        "pointermove",
        moverArrastre,
        {
            passive: false
        }
    );

    document.addEventListener(
        "pointerup",
        terminarArrastre,
        {
            once: true
        }
    );

    document.addEventListener(
        "pointercancel",
        cancelarArrastre,
        {
            once: true
        }
    );
}


function moverArrastre(evento) {

    if (!arrastre) return;

    const x =
        evento.clientX -
        arrastre.inicioX;

    const y =
        evento.clientY -
        arrastre.inicioY;

    const distancia =
        Math.hypot(
            x,
            y
        );

    if (
        !arrastre.activo &&
        distancia >=
            DISTANCIA_MINIMA_ARRASTRE
    ) {

        activarArrastre(
            evento
        );
    }

    if (
        !arrastre ||
        !arrastre.activo
    ) {

        return;
    }

    evento.preventDefault();

    moverFantasma(
        evento.clientX,
        evento.clientY
    );

    actualizarDestinoVisual(
        evento.clientX,
        evento.clientY
    );
}


function activarArrastre(evento) {

    if (!arrastre) return;

    arrastre.activo =
        true;

    bloquearClickHasta =
        Date.now() + 500;

    arrastre.elemento
        ?.classList
        .add(
            "arrastrando"
        );

    fantasmaArrastre =
        document.createElement(
            "div"
        );

    fantasmaArrastre.className =
        "fantasma-arrastre";


    if (
        arrastre.tipo ===
        "salto"
    ) {

        fantasmaArrastre.innerHTML =
            "<span>P</span>";
    }


    if (
        arrastre.tipo ===
        "cementerio"
    ) {

        const carta =
            cartaCementerioActual;

        fantasmaArrastre.classList.add(
            `palo-${carta.palo}`
        );

        fantasmaArrastre.innerHTML = `

            <strong>
                ${carta.numero}
            </strong>

            <span>
                ${simboloCarta(carta)}
            </span>

        `;
    }

    document.body.appendChild(
        fantasmaArrastre
    );

    moverFantasma(
        evento.clientX,
        evento.clientY
    );


    if (
        arrastre.tipo ===
        "salto"
    ) {

        $("cementerio")
            .classList.add(
                "destino-posible"
            );
    }


    if (
        arrastre.tipo ===
        "cementerio"
    ) {

        document
            .querySelectorAll(
                "#cartas .carta"
            )
            .forEach(
                carta => {

                    carta.classList.add(
                        "destino-posible"
                    );
                }
            );
    }
}


function moverFantasma(
    x,
    y
) {

    if (
        !fantasmaArrastre
    ) {

        return;
    }

    fantasmaArrastre.style.left =
        `${x}px`;

    fantasmaArrastre.style.top =
        `${y}px`;
}


function actualizarDestinoVisual(
    x,
    y
) {

    document
        .querySelectorAll(
            ".destino-activo"
        )
        .forEach(
            elemento => {

                elemento.classList.remove(
                    "destino-activo"
                );
            }
        );

    const debajo =
        document.elementFromPoint(
            x,
            y
        );

    if (!debajo) return;


    if (
        arrastre.tipo ===
        "salto"
    ) {

        const cementerio =
            debajo.closest(
                "#cementerio"
            );

        if (cementerio) {

            cementerio.classList.add(
                "destino-activo"
            );
        }
    }


    if (
        arrastre.tipo ===
        "cementerio"
    ) {

        const carta =
            debajo.closest(
                "#cartas .carta"
            );

        if (carta) {

            carta.classList.add(
                "destino-activo"
            );
        }
    }
}


function terminarArrastre(
    evento
) {

    document.removeEventListener(
        "pointermove",
        moverArrastre
    );

    if (!arrastre) return;

    if (
        !arrastre.activo
    ) {

        limpiarArrastre();

        return;
    }

    const debajo =
        document.elementFromPoint(
            evento.clientX,
            evento.clientY
        );


    // ==================================================
    // SALTO DE FE
    // ==================================================

    if (
        arrastre.tipo ===
        "salto"
    ) {

        const cementerio =
            debajo?.closest(
                "#cementerio"
            );

        if (cementerio) {

            /*
                No enviamos qué número creemos que es.

                Enviamos solamente el índice.

                El SERVIDOR mira cuál es la carta
                que está arriba del cementerio
                justo en este momento.
            */

            socket.emit(
                "intentarSaltoDeFe",
                arrastre.indice
            );
        }
    }


    // ==================================================
    // CEMENTERIO -> MANO
    // ==================================================

    if (
        arrastre.tipo ===
        "cementerio"
    ) {

        const destino =
            debajo?.closest(
                "#cartas .carta"
            );

        if (destino) {

            const indice =
                Number(
                    destino
                        .dataset
                        .indice
                );

            if (
                Number.isInteger(
                    indice
                )
            ) {

                socket.emit(
                    "tomarCementerioYReemplazar",
                    indice
                );
            }
        }
    }

    limpiarArrastre();
}


function cancelarArrastre() {

    document.removeEventListener(
        "pointermove",
        moverArrastre
    );

    limpiarArrastre();
}


function limpiarArrastre() {

    arrastre
        ?.elemento
        ?.classList
        ?.remove(
            "arrastrando"
        );

    if (
        fantasmaArrastre
    ) {

        fantasmaArrastre.remove();

        fantasmaArrastre =
            null;
    }

    document
        .querySelectorAll(
            ".destino-posible, .destino-activo"
        )
        .forEach(
            elemento => {

                elemento.classList.remove(
                    "destino-posible",
                    "destino-activo"
                );
            }
        );

    arrastre =
        null;
}


// ======================================================
// SELECCIONABLES
// ======================================================

function actualizarSeleccionables() {

    document
        .querySelectorAll(
            ".carta"
        )
        .forEach(
            carta => {

                carta.classList.remove(
                    "seleccionable",
                    "poder-seleccionable",
                    "arrastrable-salto"
                );
            }
        );


    /*
        Salto disponible siempre que
        exista una carta superior.
    */

    if (
        partidaIniciada &&
        !fasePreparacion &&
        !faseEntreRondas &&
        cartaCementerioActual
    ) {

        document
            .querySelectorAll(
                "#cartas .carta"
            )
            .forEach(
                carta => {

                    carta.classList.add(
                        "arrastrable-salto"
                    );
                }
            );
    }


    if (
        cartaSacada &&
        miTurno
    ) {

        document
            .querySelectorAll(
                "#cartas .carta"
            )
            .forEach(
                carta => {

                    carta.classList.add(
                        "seleccionable"
                    );
                }
            );
    }


    if (
        accionEspecial &&
        miTurno
    ) {

        if (
            accionEspecial.tipo ===
            "verPropia"
        ) {

            document
                .querySelectorAll(
                    "#cartas .carta"
                )
                .forEach(
                    carta => {

                        carta.classList.add(
                            "poder-seleccionable"
                        );
                    }
                );
        }


        if (
            accionEspecial.tipo ===
            "verRival"
        ) {

            document
                .querySelectorAll(
                    ".carta-rival"
                )
                .forEach(
                    carta => {

                        carta.classList.add(
                            "poder-seleccionable"
                        );
                    }
                );
        }


        if (
            accionEspecial.tipo ===
            "intercambiar"
        ) {

            if (
                indicePropioIntercambio ===
                null
            ) {

                document
                    .querySelectorAll(
                        "#cartas .carta"
                    )
                    .forEach(
                        carta => {

                            carta.classList.add(
                                "poder-seleccionable"
                            );
                        }
                    );

            } else {

                document
                    .querySelectorAll(
                        ".carta-rival"
                    )
                    .forEach(
                        carta => {

                            carta.classList.add(
                                "poder-seleccionable"
                            );
                        }
                    );
            }
        }
    }


    $("cementerio")
        .classList
        .toggle(
            "arrastrable-cementerio",

            Boolean(
                miTurno &&
                !fasePreparacion &&
                !faseEntreRondas &&
                !cartaSacada &&
                !accionEspecial &&
                cartaCementerioActual
            )
        );
}


// ======================================================
// CARTA SACADA
// ======================================================

function mostrarCartaSacada(
    carta
) {

    cartaSacada =
        carta;

    indiceReemplazo =
        null;

    $("zonaCartaSacada")
        .classList.remove(
            "oculto"
        );

    $("opcionesCarta")
        .classList.remove(
            "oculto"
        );

    const elemento =
        document.createElement(
            "div"
        );

    elemento.dataset.indice =
        "0";

    mostrarValorEnCarta(
        elemento,
        carta
    );

    $("cartaSacada")
        .innerHTML =
        "";

    $("cartaSacada")
        .appendChild(
            elemento
        );

    estado(
        "Elegí una de tus cartas para reemplazarla o descartá la carta sacada."
    );

    actualizarSeleccionables();
}


function ocultarCartaSacada() {

    cartaSacada =
        null;

    indiceReemplazo =
        null;

    $("zonaCartaSacada")
        .classList.add(
            "oculto"
        );

    $("opcionesCarta")
        .classList.add(
            "oculto"
        );

    $("cartaSacada")
        .innerHTML =
        "";

    document
        .querySelectorAll(
            "#cartas .carta"
        )
        .forEach(
            carta => {

                carta.classList.remove(
                    "seleccionada"
                );
            }
        );

    actualizarSeleccionables();
}


// ======================================================
// CEMENTERIO
// ======================================================

function renderizarCementerio(
    carta
) {

    cartaCementerioActual =
        carta;

    const elemento =
        $("cementerio");

    if (!carta) {

        elemento.className =
            "cementerio vacio";

        elemento.innerHTML =
            "<span>Vacío</span>";

        actualizarSeleccionables();

        return;
    }

    elemento.className =
        `cementerio carta-visible palo-${carta.palo}`;

    elemento.innerHTML = `

        <strong class="numero">
            ${carta.numero}
        </strong>

        <span class="simbolo">
            ${simboloCarta(carta)}
        </span>

        <small>
            ${carta.valor}
        </small>

    `;

    actualizarSeleccionables();
}


// ======================================================
// PODERES
// ======================================================

function mostrarPoder(
    tipo,
    numero
) {

    accionEspecial = {

        tipo,

        numero
    };

    indicePropioIntercambio =
        null;

    $("interfazPoder")
        .classList.remove(
            "oculto"
        );

    $("tituloPoder")
        .textContent =
        `Poder del ${numero}`;


    if (
        tipo ===
        "verPropia"
    ) {

        $("textoPoder")
            .textContent =
            "Elegí una de tus cartas para verla.";
    }


    if (
        tipo ===
        "verRival"
    ) {

        $("textoPoder")
            .textContent =
            "Elegí una carta de cualquier rival.";
    }


    if (
        tipo ===
        "intercambiar"
    ) {

        $("textoPoder")
            .textContent =
            "Primero elegí una carta tuya y después una carta rival. El intercambio es a ciegas.";
    }

    actualizarSeleccionables();
}


function ocultarPoder() {

    accionEspecial =
        null;

    indicePropioIntercambio =
        null;

    $("interfazPoder")
        .classList.add(
            "oculto"
        );

    document
        .querySelectorAll(
            ".seleccionada"
        )
        .forEach(
            carta => {

                carta.classList.remove(
                    "seleccionada"
                );
            }
        );

    actualizarSeleccionables();
}


// ======================================================
// TURNOS
// ======================================================

function actualizarTurno(
    jugadorId,
    jugadorNombre
) {

    miTurno =
        jugadorId === miId;

    if (
        faseEntreRondas
    ) {

        return;
    }

    if (miTurno) {

        $("turno")
            .textContent =
            "🟢 Tu turno";

        estado(
            "Podés tocar el mazo o el cementerio. El Salto de fe puede hacerlo cualquiera en cualquier momento."
        );

    } else {

        $("turno")
            .textContent =
            `Turno de ${jugadorNombre}`;

        estado(
            `Turno de ${jugadorNombre}. Igual podés hacer Salto de fe arrastrando una carta tuya al cementerio.`
        );
    }

    actualizarSeleccionables();
}


function iniciarRelojTurno(
    segundos
) {

    clearInterval(
        intervaloTurno
    );

    let restante =
        segundos;

    $("temporizador")
        .textContent =
        restante;

    intervaloTurno =
        setInterval(
            () => {

                restante--;

                $("temporizador")
                    .textContent =
                    Math.max(
                        restante,
                        0
                    );

                if (
                    restante <= 0
                ) {

                    clearInterval(
                        intervaloTurno
                    );
                }

            },
            1000
        );
}


// ======================================================
// PREPARACIÓN
// ======================================================

function comenzarPreparacion(
    segundos
) {

    fasePreparacion =
        true;

    faseEntreRondas =
        false;

    cartasMiradasPreparacion =
        new Set();

    $("fasePreparacion")
        .classList.remove(
            "oculto"
        );

    $("btnListoPreparacion")
        .disabled =
        false;

    $("preparacionMensaje")
        .textContent =
        "Elegí dos cartas. Las dos quedarán visibles al mismo tiempo.";

    $("contadorPreparacion")
        .textContent =
        "Miraste 0/2";

    renderizarCartasPreparacion();

    iniciarRelojPreparacion(
        segundos
    );
}


function iniciarRelojPreparacion(
    segundos
) {

    clearInterval(
        intervaloPreparacion
    );

    let restante =
        segundos;

    $("temporizadorPreparacion")
        .textContent =
        restante;

    intervaloPreparacion =
        setInterval(
            () => {

                restante--;

                $("temporizadorPreparacion")
                    .textContent =
                    Math.max(
                        restante,
                        0
                    );

                if (
                    restante <= 0
                ) {

                    clearInterval(
                        intervaloPreparacion
                    );
                }

            },
            1000
        );
}


// ======================================================
// RESULTADOS
// ======================================================

function mostrarResultados(
    datos
) {

    $("resultadosRonda")
        .classList.remove(
            "oculto"
        );

    $("quienCantoPedro")
        .textContent =
        `${datos.llamadoPor.nombre} cantó PEDRO.`;

    const resultados =
        [...datos.resultados].sort(
            (a, b) =>
                a.puntosTotales -
                b.puntosTotales
        );

    $("tablaResultados")
        .innerHTML =
        resultados.map(
            resultado => {

                const cartas =
                    resultado.cartas
                        .map(
                            carta => `

                                <span class="mini-carta">
                                    ${carta.numero}
                                    ${simboloCarta(carta)}
                                </span>

                            `
                        )
                        .join("");

                return `

                    <div class="resultado">

                        <div>

                            <strong>
                                ${escapar(resultado.nombre)}
                            </strong>

                            <div class="mini-cartas">
                                ${cartas}
                            </div>

                        </div>


                        <div class="puntaje-resultado">

                            <span>
                                +${resultado.puntosRonda}
                            </span>

                            <strong>
                                ${resultado.puntosTotales}
                            </strong>

                        </div>

                    </div>

                `;
            }
        )
        .join("");

    $("zonaSiguienteRonda")
        .classList.toggle(
            "oculto",
            Boolean(
                datos.hayFinal
            )
        );

    $("btnSiguienteRonda")
        .disabled =
        false;

    $("contadorSiguienteRonda")
        .textContent =
        `Listos para la próxima ronda: 0/${jugadores.length}`;
}


function mostrarFinal(
    datos
) {

    $("resultadoFinal")
        .classList.remove(
            "oculto"
        );

    $("resultadosRonda")
        .classList.add(
            "oculto"
        );

    $("tablaFinal")
        .innerHTML = `

            <h3>
                🏆 ${escapar(
                    datos.ganador?.nombre ||
                    ""
                )}
            </h3>

            ${
                datos.jugadores
                    .map(
                        (
                            jugador,
                            indice
                        ) => `

                            <div class="resultado">

                                <span>
                                    ${indice + 1}.
                                    ${escapar(jugador.nombre)}
                                </span>

                                <strong>
                                    ${jugador.puntos} pts
                                </strong>

                            </div>

                        `
                    )
                    .join("")
            }

        `;
}


// ======================================================
// BOTONES
// ======================================================

$("btnEntrar")
    .addEventListener(
        "click",
        () => {

            const nombre =
                $("nombreJugador")
                    .value
                    .trim();

            if (!nombre) {

                mostrarMensaje(
                    "Escribí tu nombre."
                );

                return;
            }

            socket.emit(
                "entrarPartida",
                nombre
            );
        }
    );


$("nombreJugador")
    .addEventListener(
        "keydown",
        evento => {

            if (
                evento.key ===
                "Enter"
            ) {

                $("btnEntrar")
                    .click();
            }
        }
    );


$("btnIniciar")
    .addEventListener(
        "click",
        () => {

            socket.emit(
                "iniciarPartida",
                Number(
                    $("tiempoTurno")
                        .value
                )
            );
        }
    );


$("mazo")
    .addEventListener(
        "click",
        () => {

            if (!miTurno) return;

            if (
                fasePreparacion ||
                faseEntreRondas ||
                cartaSacada ||
                accionEspecial
            ) {

                return;
            }

            socket.emit(
                "sacarCarta"
            );
        }
    );


$("cementerio")
    .addEventListener(
        "pointerdown",
        evento => {

            comenzarPosibleArrastreCementerio(
                evento
            );
        }
    );


$("cementerio")
    .addEventListener(
        "click",
        evento => {

            if (
                Date.now() <
                bloquearClickHasta
            ) {

                evento.preventDefault();

                return;
            }

            /*
                CLIC EN CEMENTERIO
                SOLO significa tomarlo.
            */

            if (!miTurno) return;

            if (
                fasePreparacion ||
                faseEntreRondas ||
                cartaSacada ||
                accionEspecial
            ) {

                return;
            }

            socket.emit(
                "sacarDelCementerio"
            );
        }
    );


$("btnCementerio")
    .addEventListener(
        "click",
        () => {

            if (
                !miTurno ||
                !cartaSacada
            ) {

                return;
            }

            socket.emit(
                "tirarAlCementerio"
            );

            ocultarCartaSacada();
        }
    );


$("btnQuedarme")
    .addEventListener(
        "click",
        () => {

            if (
                !miTurno ||
                !cartaSacada
            ) {

                return;
            }

            if (
                indiceReemplazo ===
                null
            ) {

                mostrarMensaje(
                    "Tocá una de tus cartas para elegir cuál reemplazar."
                );

                return;
            }

            socket.emit(
                "reemplazarCarta",
                indiceReemplazo
            );

            ocultarCartaSacada();
        }
    );


$("btnListo")
    .addEventListener(
        "click",
        () => {

            if (!accionEspecial) return;

            socket.emit(
                "terminarAccionEspecial"
            );
        }
    );


$("btnListoPreparacion")
    .addEventListener(
        "click",
        () => {

            if (!fasePreparacion) return;

            socket.emit(
                "listoPreparacion"
            );

            $("btnListoPreparacion")
                .disabled =
                true;

            $("preparacionMensaje")
                .textContent =
                "Listo. Esperando al resto...";
        }
    );


$("btnSiguienteRonda")
    .addEventListener(
        "click",
        () => {

            if (!faseEntreRondas) return;

            socket.emit(
                "listoSiguienteRonda"
            );

            $("btnSiguienteRonda")
                .disabled =
                true;
        }
    );


$("btnPedro")
    .addEventListener(
        "click",
        () => {

            if (!partidaIniciada) return;
            if (faseEntreRondas) return;

            socket.emit(
                "cantarPedro"
            );
        }
    );


$("btnVolverLobby")
    .addEventListener(
        "click",
        () => {

            window.location.reload();
        }
    );

$("btnReglas")
    .addEventListener(
        "click",
        () => {

            abrirReglas();
        }
    );


$("btnCerrarReglas")
    .addEventListener(
        "click",
        () => {

            cerrarReglas();
        }
    );


$("panelReglas")
    .addEventListener(
        "click",
        evento => {

            if (
                evento.target ===
                $("panelReglas")
            ) {

                cerrarReglas();
            }
        }
    );
// ======================================================
// SOCKET
// ======================================================

socket.on(
    "connect",
    () => {

        miId =
            socket.id;
    }
);


socket.on(
    "estadoInicial",
    datos => {

        jugadores =
            datos.jugadores || [];

        partidaIniciada =
            datos.partidaIniciada;

        fasePreparacion =
            datos.fasePreparacion;

        faseEntreRondas =
            datos.faseEntreRondas;

        renderizarLobby();
        renderizarJugadoresMesa();
        renderizarMarcador();
    }
);


socket.on(
    "entradaConfirmada",
    datos => {

        miId =
            datos.id;

        miNombre =
            datos.nombre;

        $("nombreJugador")
            .disabled =
            true;

        $("btnEntrar")
            .disabled =
            true;

        mostrarMensaje(
            `Entraste como ${miNombre}.`
        );
    }
);


socket.on(
    "jugadoresActualizados",
    datos => {

        jugadores =
            datos.jugadores || [];

        partidaIniciada =
            datos.partidaIniciada;

        fasePreparacion =
            datos.fasePreparacion;

        faseEntreRondas =
            datos.faseEntreRondas;

        renderizarLobby();
        renderizarMarcador();
        renderizarJugadoresMesa();

        const listosPreparacion =
            jugadores.filter(
                jugador =>
                    jugador.listo
            ).length;

        $("contadorListos")
            .textContent =
            `Listos ${listosPreparacion}/${jugadores.length}`;

        if (
            faseEntreRondas
        ) {

            const listosRonda =
                jugadores.filter(
                    jugador =>
                        jugador
                            .listoEntreRondas
                ).length;

            $("contadorSiguienteRonda")
                .textContent =
                `Listos para la próxima ronda: ${listosRonda}/${jugadores.length}`;
        }

        if (
            partidaIniciada
        ) {

            $("lobby")
                .classList.add(
                    "oculto"
                );

            $("juego")
                .classList.remove(
                    "oculto"
                );

        } else {

            $("juego")
                .classList.add(
                    "oculto"
                );

            $("lobby")
                .classList.remove(
                    "oculto"
                );
        }

        actualizarSeleccionables();
    }
);


socket.on(
    "partidaIniciada",
    () => {

        partidaIniciada =
            true;

        $("lobby")
            .classList.add(
                "oculto"
            );

        $("juego")
            .classList.remove(
                "oculto"
            );
    }
);


socket.on(
    "nuevaRonda",
    datos => {

        faseEntreRondas =
            false;

        $("numeroRonda")
            .textContent =
            datos.ronda;

        $("resultadosRonda")
            .classList.add(
                "oculto"
            );

        cartaSacada =
            null;

        indiceReemplazo =
            null;

        accionEspecial =
            null;

        indicePropioIntercambio =
            null;

        ocultarCartaSacada();
        ocultarPoder();
    }
);


socket.on(
    "cartasActuales",
    datos => {

        misCartas =
            datos.cartas || [];

        renderizarCartasPropias();

        if (
            fasePreparacion
        ) {

            renderizarCartasPreparacion();
        }
    }
);


socket.on(
    "fasePreparacion",
    datos => {

        comenzarPreparacion(
            datos.segundos
        );
    }
);


socket.on(
    "jugadorListo",
    datos => {

        mostrarMensaje(
            `${datos.jugadorNombre} está listo.`
        );
    }
);


socket.on(
    "finFasePreparacion",
    () => {

        fasePreparacion =
            false;

        clearInterval(
            intervaloPreparacion
        );

        $("fasePreparacion")
            .classList.add(
                "oculto"
            );

        actualizarSeleccionables();
    }
);


socket.on(
    "turnoActual",
    datos => {

        actualizarTurno(
            datos.jugadorId,
            datos.jugadorNombre
        );
    }
);


socket.on(
    "temporizadorIniciado",
    datos => {

        iniciarRelojTurno(
            datos.segundos
        );
    }
);


socket.on(
    "turnoAgotado",
    datos => {

        if (
            datos.jugadorId ===
            miId
        ) {

            ocultarCartaSacada();
            ocultarPoder();

            mostrarMensaje(
                "Se terminó tu tiempo."
            );
        }
    }
);


socket.on(
    "cartaSacada",
    datos => {

        mostrarCartaSacada(
            datos.carta
        );
    }
);


socket.on(
    "cementerioActualizado",
    datos => {

        renderizarCementerio(
            datos.carta
        );
    }
);


// ======================================================
// SALTO
// ======================================================

socket.on(
    "saltoDeFeAcertado",
    datos => {

        if (
            datos.jugadorId ===
            miId
        ) {

            mostrarMensaje(
                `🔥 ¡Salto de fe correcto! Tiraste tu ${datos.numero}.`
            );

        } else {

            mostrarMensaje(
                `🔥 ${datos.jugadorNombre} tiró un ${datos.numero} por Salto de fe.`
            );
        }
    }
);


socket.on(
    "saltoDeFeFallido",
    datos => {

        if (
            datos.jugadorId ===
            miId
        ) {

            mostrarMensaje(
                "❌ La carta de arriba cambió o tu carta no coincidía. Penalización."
            );
        }
    }
);


socket.on(
    "cartaPenalizacion",
    datos => {

        mostrarMensaje(
            `Recibiste de penalización: ${datos.carta.numero} ${simboloCarta(datos.carta)}`
        );
    }
);


// ======================================================
// PODER
// ======================================================

socket.on(
    "poderDisponible",
    datos => {

        mostrarPoder(
            datos.tipo,
            datos.numero
        );
    }
);


socket.on(
    "poderCartaRevelada",
    datos => {

        if (
            datos.jugador ===
            miId
        ) {

            const elemento =
                document.querySelector(
                    `#cartas .carta[data-indice="${datos.indice}"]`
                );

            if (elemento) {

                revelarTemporalmente(
                    elemento,
                    datos.carta,
                    4000
                );
            }

            return;
        }

        const cartaRival =
            document.querySelector(
                `.carta-rival[data-jugador-id="${datos.jugador}"][data-indice="${datos.indice}"]`
            );

        if (
            cartaRival
        ) {

            revelarTemporalmente(
                cartaRival,
                datos.carta,
                4000
            );
        }
    }
);


socket.on(
    "intercambioRealizado",
    datos => {

        mostrarMensaje(
            `${datos.jugadorNombre} intercambió una carta con ${datos.rivalNombre}.`
        );
    }
);


socket.on(
    "poderUsado",
    () => {

        ocultarPoder();
    }
);


// ======================================================
// PEDRO / ENTRE RONDAS
// ======================================================

socket.on(
    "rondaTerminada",
    datos => {

        clearInterval(
            intervaloTurno
        );

        miTurno =
            false;

        ocultarCartaSacada();
        ocultarPoder();

        mostrarResultados(
            datos
        );
    }
);


socket.on(
    "esperandoSiguienteRonda",
    datos => {

        faseEntreRondas =
            true;

        $("btnSiguienteRonda")
            .disabled =
            false;

        $("contadorSiguienteRonda")
            .textContent =
            `Listos para la próxima ronda: ${datos.listos}/${datos.total}`;

        actualizarSeleccionables();
    }
);


socket.on(
    "estadoListosSiguienteRonda",
    datos => {

        $("contadorSiguienteRonda")
            .textContent =
            `Listos para la próxima ronda: ${datos.listos}/${datos.total}`;
    }
);


socket.on(
    "partidaTerminada",
    datos => {

        partidaIniciada =
            false;

        faseEntreRondas =
            false;

        mostrarFinal(
            datos
        );
    }
);


socket.on(
    "partidaReiniciada",
    datos => {

        partidaIniciada =
            false;

        fasePreparacion =
            false;

        faseEntreRondas =
            false;

        $("fasePreparacion")
            .classList.add(
                "oculto"
            );

        $("resultadosRonda")
            .classList.add(
                "oculto"
            );

        $("juego")
            .classList.add(
                "oculto"
            );

        $("lobby")
            .classList.remove(
                "oculto"
            );

        mostrarMensaje(
            datos.motivo,
            5000
        );
    }
);


socket.on(
    "errorJuego",
    mensaje => {

        mostrarMensaje(
            mensaje,
            3500
        );
    }
);