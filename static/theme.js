/* Site-wide light/dark theme.

   Loaded as the very first thing in <head> on every page, before the
   stylesheets - so the correct data-theme attribute is set on <html>
   before anything paints, avoiding a flash of the wrong theme. This file
   only decides and applies the theme; the actual toggle button lives in
   the shared nav dropdown (nav.js), which calls into window.MoSiteTheme
   below rather than duplicating this logic. */

(function () {
  "use strict";

  var STORAGE_KEY = "mosite-theme";

  function getStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null; // privacy mode / storage disabled - just fall back
    }
  }

  function preferredTheme() {
    var saved = getStored();
    if (saved === "light" || saved === "dark") return saved;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark" : "light";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  var current = preferredTheme();
  apply(current);

  function setTheme(theme) {
    if (theme !== "light" && theme !== "dark") return;
    current = theme;
    apply(theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
    window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: theme } }));
  }

  window.MoSiteTheme = {
    get: function () { return current; },
    set: setTheme,
    toggle: function () { setTheme(current === "dark" ? "light" : "dark"); }
  };
})();
