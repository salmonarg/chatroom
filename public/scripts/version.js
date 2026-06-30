const VERSION = "v1.15.0-dev.1";

document.addEventListener("DOMContentLoaded", () => {
    const versionElements = document.querySelectorAll('.app-ver');
    versionElements.forEach(el => {
        el.textContent = VERSION;
    });
});
