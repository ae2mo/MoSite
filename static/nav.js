/* Shared site navigation dropdown.
   Any page that wants the menu needs:
     <button type="button" class="brand-mark" id="nav-menu-trigger" aria-haspopup="true" aria-expanded="false">$</button>
     <div class="nav-menu" id="nav-menu" hidden></div>
   and <body data-page="budget"> (or whatever key matches PAGES below). */

(function () {
  "use strict";

  var PAGES = [
    { key: "budget", title: "Budget", desc: "Income, expenses, savings, 401K/TSP", href: "/" },
    { key: "stocks", title: "Stock Trader", desc: "Alpaca momentum screener & orders", href: "/stocks/" },
    { key: "meals", title: "Meal Planner", desc: "Favorite meals, weekly plan, shopping list", href: "/meals/" },
    { key: "maintenance", title: "Home/Car Maintenance", desc: "Maintenance logbook for the house and cars", href: "/maintenance/" }
  ];

  function init() {
    var trigger = document.getElementById("nav-menu-trigger");
    var menu = document.getElementById("nav-menu");
    if (!trigger || !menu) return;

    var currentPage = document.body.dataset.page || "";

    menu.innerHTML = "";
    PAGES.forEach(function (p) {
      var a = document.createElement("a");
      a.href = p.href;
      if (p.key === currentPage) a.classList.add("active");
      a.innerHTML =
        '<span class="nav-item-title">' + p.title + "</span>" +
        '<span class="nav-item-desc">' + p.desc + "</span>";
      menu.appendChild(a);
    });

    if (window.MoSiteTheme) {
      var divider = document.createElement("div");
      divider.className = "nav-menu-divider";
      menu.appendChild(divider);

      var themeBtn = document.createElement("button");
      themeBtn.type = "button";
      themeBtn.className = "nav-theme-toggle";

      function renderThemeBtn() {
        var isDark = window.MoSiteTheme.get() === "dark";
        themeBtn.innerHTML =
          '<span class="nav-item-title">' + (isDark ? "&#9728; Switch to Light Mode" : "&#9789; Switch to Dark Mode") + "</span>" +
          '<span class="nav-item-desc">Currently ' + (isDark ? "dark" : "light") + "</span>";
      }
      renderThemeBtn();

      themeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        window.MoSiteTheme.toggle();
      });
      window.addEventListener("themechange", renderThemeBtn);

      menu.appendChild(themeBtn);
    }

    function closeMenu() {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    }
    function openMenu() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    });

    document.addEventListener("click", function (e) {
      if (!menu.hidden && e.target !== trigger && !menu.contains(e.target)) closeMenu();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
