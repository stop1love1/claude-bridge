/**
 * Theme no-flash bootstrap — server-safe constants only (no React).
 * Inlined in <head> before hydration so `data-theme` matches storage /
 * system preference on first paint.
 */
export const THEME_STORAGE_KEY = "bridge.theme";

// JSON.stringify the key so a future change cannot break or inject via
// the inlined boot script.
export const NO_FLASH_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var s=localStorage.getItem(k);var t;if(s==='dark'||s==='light'){t=s;}else{t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}var d=document.documentElement;d.setAttribute('data-theme',t);d.style.colorScheme=t;}catch(e){}})();`;
