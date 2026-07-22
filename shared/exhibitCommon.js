// =====================================================================
// exhibitCommon.js — delt boilerplate for alle exhibit-sider.
//
// Hvert exhibit har sin egen renderer, sit eget kamera, sin egen
// shader — det er der ikke noget at dele, og vi skal ikke prøve.
// Men math-panelets åbne/luk-logik og resize-håndteringen er
// bogstaveligt talt identisk kode, kopieret fire gange. Denne fil er
// single source of truth for præcis de to ting, og kun dem.
// =====================================================================

/**
 * Kobler "Math"-knappen (og et evt. luk-kryds) til at toggle panelet.
 * Virker uanset om exhibitet har en .math-close-knap eller ej — den
 * tjekker bare om den findes, i stedet for at kræve den.
 */
export function wireMathPanel(panelId = 'mathPanel', btnId = 'mathBtn') {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel || !btn) return;

    btn.addEventListener('click', () => panel.classList.toggle('hidden'));

    const closeBtn = panel.querySelector('.math-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
    }
}

/**
 * Kalder onResize(width, height) med det samme, og igen hver gang
 * canvas'ets FAKTISKE størrelse ændrer sig. ResizeObserver er en
 * opgradering fra window's 'resize' event — den fanger fx layout-
 * ændringer der ikke involverer selve browservinduet, og du slipper
 * for at kalde funktionen manuelt én gang ved opstart bagefter.
 */
export function observeCanvasResize(canvas, onResize) {
    const fire = () => onResize(canvas.clientWidth, canvas.clientHeight);
    new ResizeObserver(fire).observe(canvas);
    fire();
}

/**
 * Aspect-bevidst FOV til PerspectiveCamera — samme matematik fra
 * mobil-runden. Ren funktion, intet DOM, ingen side-effekter — let
 * at genbruge, let at teste isoleret.
 */
export function fitPerspectiveFov(aspect, baseFov) {
    return aspect < 1 ? baseFov / aspect : baseFov;
}