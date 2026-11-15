"use strict";

/* ==========================================================================
   Geldhirn – app.js
   Vanilla JavaScript, keine externen Abhängigkeiten.
   Alle Berechnungen laufen ausschließlich im Browser. Es werden aktuell
   keine personenbezogenen Daten an einen Server übertragen.
   ========================================================================== */

(function () {

  /* ------------------------------------------------------------------
     Platzhalter für spätere Backend-Anbindung.
     TODO FUTURE: Diese Endpunkte werden später an einen n8n-Webhook
     angebunden, der Daten (nach Zustimmung des Nutzers) an Supabase,
     Partner-Systeme oder die OpenAI/Claude API weiterleitet.
     Aktuell werden HIER KEINE Daten versendet.
  ------------------------------------------------------------------ */
  const API_ENDPOINTS = {
    tariffLead: "/api/leads/tariff",
    insuranceLead: "/api/leads/insurance",
    objectAnalysis: "/api/object-analysis",
    objectFinder: "/api/object-finder"
  };

  /* ------------------------------------------------------------------
     Anbindung an Supabase (Login/Datenbank) und Stripe (Zahlungen).
     Die eigentlichen Zugangsdaten stehen in config.js (window.GELDHIRN_CONFIG),
     das auf jeder Seite vor dieser Datei eingebunden ist. Solange dort nur
     Platzhalter stehen, bleibt die Seite eine reine Vorschau (wie bisher):
     alle Formulare unten erkennen das automatisch und fallen auf den
     bekannten Demo-Hinweis zurück. Siehe SETUP.md für die Einrichtung.
  ------------------------------------------------------------------ */
  const CONFIG = (typeof window !== "undefined" && window.GELDHIRN_CONFIG) ? window.GELDHIRN_CONFIG : {
    isSupabaseConfigured: function () { return false; },
    isStripePaymentLinkConfigured: function () { return false; },
    isStripePaymentLinkAnnualConfigured: function () { return false; },
    isStripePortalConfigured: function () { return false; }
  };

  // Ordnet einem data-stripe-checkout-Wert ("pro" = monatlich, "pro-annual" =
  // jaehrlich) den passenden Stripe Payment Link sowie dessen Konfigurationsstatus
  // zu. Zentral an einer Stelle, damit Demo-Fallback und echte Weiterleitung
  // immer denselben Plan meinen.
  function stripePlanFor(value) {
    if (value === "pro-annual") {
      return { url: CONFIG.stripePaymentLinkProAnnual, configured: !!CONFIG.isStripePaymentLinkAnnualConfigured && CONFIG.isStripePaymentLinkAnnualConfigured() };
    }
    return { url: CONFIG.stripePaymentLinkPro, configured: CONFIG.isStripePaymentLinkConfigured() };
  }

  function createSupabaseClientSafely() {
    // Absichtlich defensiv: Ein Tippfehler in config.js oder eine blockierte
    // CDN-Anfrage (z. B. kein Internet) darf niemals die restliche Seite
    // (Rechner, Selbsttests, rechtliche Hinweise) lahmlegen.
    try {
      if (
        CONFIG.isSupabaseConfigured() &&
        typeof window !== "undefined" &&
        typeof window.supabase !== "undefined" &&
        typeof window.supabase.createClient === "function"
      ) {
        return window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
      }
    } catch (e) {
      console.error("Supabase-Client konnte nicht erstellt werden:", e);
    }
    return null;
  }

  const supabaseClient = createSupabaseClientSafely();

  function isBackendReady() {
    return !!supabaseClient;
  }

  let currentUser = null;
  let currentProfile = null;
  let currentSubscription = null;
  const authListeners = [];

  function registerAuthListener(fn) {
    authListeners.push(fn);
  }

  function notifyAuthListeners() {
    authListeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* ein fehlerhafter Listener soll die anderen nicht stoppen */ }
    });
  }

  function hasProAccess() {
    return !!currentSubscription &&
      currentSubscription.plan === "pro" &&
      (currentSubscription.status === "active" || currentSubscription.status === "trialing");
  }

  function fetchProfile(userId) {
    if (!isBackendReady()) return Promise.resolve(null);
    return supabaseClient.from("profiles").select("*").eq("id", userId).maybeSingle()
      .then(function (res) { return (res && res.data) || null; })
      .catch(function () { return null; });
  }

  function fetchSubscription(userId) {
    if (!isBackendReady()) return Promise.resolve(null);
    return supabaseClient.from("subscriptions").select("*").eq("user_id", userId).maybeSingle()
      .then(function (res) { return (res && res.data) || null; })
      .catch(function () { return null; });
  }

  function handleAuthChange(session) {
    currentUser = session ? session.user : null;
    if (!currentUser) {
      currentProfile = null;
      currentSubscription = null;
      notifyAuthListeners();
      return;
    }
    Promise.all([fetchProfile(currentUser.id), fetchSubscription(currentUser.id)]).then(function (results) {
      currentProfile = results[0];
      currentSubscription = results[1];
      notifyAuthListeners();
    });
  }

  /* Ermittelt den relativen Pfad-Präfix zur Startseite (z. B. "" auf Root-Seiten,
     "../" in Unterordnern), indem der bereits vorhandene Link auf die Startseite
     im Header ausgelesen wird. So müssen Pfade nicht pro Seite hart codiert werden. */
  function sitePrefix() {
    const brand = document.querySelector(".brand");
    if (!brand) return "";
    const href = brand.getAttribute("href") || "";
    return href.replace(/index\.html.*$/, "");
  }

  function initSupabaseAuthWatcher() {
    if (!isBackendReady()) return;
    try {
      supabaseClient.auth.getSession().then(function (res) {
        handleAuthChange(res && res.data ? res.data.session : null);
      }).catch(function (e) { console.error("Supabase-Sitzung konnte nicht geladen werden:", e); });
      supabaseClient.auth.onAuthStateChange(function (event, session) {
        handleAuthChange(session);
      });
    } catch (e) {
      console.error("Supabase-Auth-Überwachung konnte nicht gestartet werden:", e);
    }
  }

  /* ===================== Formatierungs-Hilfsfunktionen ===================== */

  function formatEuro(value) {
    if (typeof value !== "number" || !isFinite(value)) return "–";
    return value.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  }

  function formatEuroCents(value) {
    if (typeof value !== "number" || !isFinite(value)) return "–";
    return value.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
  }

  function formatPercent(value, digits) {
    if (typeof value !== "number" || !isFinite(value)) return "–";
    return value.toLocaleString("de-DE", { minimumFractionDigits: digits || 1, maximumFractionDigits: digits || 1 }) + " %";
  }

  function formatNumber(value, digits) {
    if (typeof value !== "number" || !isFinite(value)) return "–";
    return value.toLocaleString("de-DE", { minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 2 });
  }

  function parseNumberInput(el) {
    if (!el) return NaN;
    const val = parseFloat(String(el.value).replace(",", "."));
    return isNaN(val) ? NaN : val;
  }

  /* ===================== Stammdaten (persoenliches Basisprofil) =====================
     Einmal eingegebene Basisdaten (Nettoeinkommen, Wohnkosten, Energiekosten, Haushaltsgroesse
     usw.) werden lokal gespeichert, damit sie in anderen Rechnern (v.a. der Machbarkeitsrechner-
     Komplettversion) automatisch vorausgefuellt werden koennen. Rein lokal (localStorage),
     keine Uebertragung an einen Server. */
  var STAMMDATEN_KEY = "echtkosten_stammdaten_v1";

  /* Reine Funktion (kein I/O) - sicher fuer Selbsttests: fuehrt bestehende Stammdaten
     mit neuen Teildaten zusammen, ohne undefined/NaN-Werte zu uebernehmen. */
  function mergeStammdatenData(current, partial) {
    var base = current && typeof current === "object" ? current : {};
    var result = {};
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) result[k] = base[k];
    }
    if (partial && typeof partial === "object") {
      for (var key in partial) {
        if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
        var v = partial[key];
        if (v === undefined || v === null) continue;
        if (typeof v === "number" && !isFinite(v)) continue;
        result[key] = v;
      }
    }
    return result;
  }

  /* Reine Funktion (kein I/O) - sicher fuer Selbsttests: schaetzt durchschnittliche
     monatliche Lebensmittelkosten je nach Personenzahl im Haushalt.
     Grundlage: Destatis (Einpersonenhaushalt ca. 245-250 Euro/Monat) und
     Destatis/YouGov (Durchschnittshaushalt ~2 Personen ca. 400-430 Euro/Monat). */
  function suggestGroceryCost(persons) {
    var p = typeof persons === "number" && isFinite(persons) ? persons : 1;
    p = Math.max(1, Math.min(8, Math.round(p)));
    return 250 + (p - 1) * 180;
  }

  /* I/O-Funktionen - werden NICHT in Selbsttests ausgefuehrt, da sie echte
     Nutzerdaten in localStorage lesen/schreiben. localStorage kann im privaten
     Modus/aus Datenschutzgruenden blockiert sein - daher immer try/catch. */
  function getStammdaten() {
    try {
      var raw = window.localStorage.getItem(STAMMDATEN_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveStammdaten(partial) {
    try {
      var current = getStammdaten();
      var merged = mergeStammdatenData(current, partial);
      window.localStorage.setItem(STAMMDATEN_KEY, JSON.stringify(merged));
      return merged;
    } catch (e) {
      return getStammdaten();
    }
  }

  function hasStammdatenValue(key) {
    var data = getStammdaten();
    var v = data[key];
    return v !== undefined && v !== null && v !== "" && !(typeof v === "number" && !isFinite(v));
  }

  /* ===================== Range-Slider ("Cursor") ===================== */
  /* Zahlenfelder werden als <input type="range"> mit begleitender Live-Anzeige
     (<output class="slider-value" id="{feldid}-value">) dargestellt. Das
     data-unit-Attribut steuert die Formatierung der Live-Anzeige. */

  function formatSliderValue(input) {
    const value = parseFloat(input.value);
    if (!isFinite(value)) return "–";
    const unit = input.dataset.unit || "";
    const decimals = input.dataset.decimals !== undefined ? parseInt(input.dataset.decimals, 10) : undefined;

    switch (unit) {
      case "euro": return formatEuro(value);
      case "euro-cent": return formatEuroCents(value);
      case "percent": return formatPercent(value, decimals !== undefined ? decimals : 1);
      case "jahre": return formatNumber(value, 0) + (value === 1 ? " Jahr" : " Jahre");
      case "qm": return formatNumber(value, 0) + " m²";
      case "kwp": return formatNumber(value, decimals !== undefined ? decimals : 1) + " kWp";
      case "kwh": return formatNumber(value, 0) + " kWh";
      case "kwh-kwp": return formatNumber(value, 0) + " kWh/kWp";
      case "km": return formatNumber(value, 0) + " km";
      case "liter": return formatNumber(value, decimals !== undefined ? decimals : 1) + " l";
      case "l100km": return formatNumber(value, decimals !== undefined ? decimals : 1) + " l/100 km";
      case "eurol": return formatNumber(value, decimals !== undefined ? decimals : 2) + " €/l";
      case "kwh100": return formatNumber(value, decimals !== undefined ? decimals : 1) + " kWh/100 km";
      case "jahr": return String(Math.round(value));
      case "personen": return formatNumber(value, 0) + (value === 1 ? " Person" : " Personen");
      case "monate": return formatNumber(value, 0) + (value === 1 ? " Monat" : " Monate");
      default: return formatNumber(value, decimals !== undefined ? decimals : 0);
    }
  }

  function updateSliderDisplay(input) {
    const out = document.getElementById(input.id + "-value");
    if (out) out.textContent = formatSliderValue(input);
  }

  function setSliderValue(id, value) {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = value;
    updateSliderDisplay(input);
  }

  function initSliders(scopeEl) {
    const sliders = (scopeEl || document).querySelectorAll('input[type="range"]');
    sliders.forEach(function (input) {
      updateSliderDisplay(input);
      input.addEventListener("input", function () { updateSliderDisplay(input); });
    });
  }

  /* ===================== Modal / Demo-Dialog ===================== */

  const modalOverlay = document.getElementById("modal-overlay");
  const modalTitle = document.getElementById("modal-title");
  const modalText = document.getElementById("modal-text");
  const modalClose = document.getElementById("modal-close");
  let lastFocusedElement = null;

  function showModal(title, text) {
    modalTitle.textContent = title;
    modalText.textContent = text;
    lastFocusedElement = document.activeElement;
    modalOverlay.hidden = false;
    modalClose.focus();
  }

  function hideModal() {
    modalOverlay.hidden = true;
    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
      lastFocusedElement.focus();
    }
  }

  modalClose.addEventListener("click", hideModal);
  modalOverlay.addEventListener("click", function (e) {
    if (e.target === modalOverlay) hideModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modalOverlay.hidden) hideModal();
  });

  /* ===================== Mobiles Menü ===================== */

  function initMobileNav() {
    const toggle = document.getElementById("nav-toggle");
    const nav = document.getElementById("main-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      const isOpen = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });

    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ===================== Hauptnav: "Rechner"-Dropdown ===================== */

  function closeNavDropdown(item) {
    item.classList.remove("is-open");
    const caret = item.querySelector(".nav-dropdown-caret");
    if (caret) caret.setAttribute("aria-expanded", "false");
  }

  function closeAllNavDropdowns(except) {
    document.querySelectorAll(".nav-dropdown.is-open").forEach(function (item) {
      if (item !== except) closeNavDropdown(item);
    });
  }

  function initNavDropdowns() {
    const items = document.querySelectorAll(".nav-dropdown");
    if (!items.length) return;

    items.forEach(function (item) {
      const caret = item.querySelector(".nav-dropdown-caret");
      if (!caret) return;

      caret.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = !item.classList.contains("is-open");
        closeAllNavDropdowns(item);
        if (willOpen) {
          item.classList.add("is-open");
          caret.setAttribute("aria-expanded", "true");
        } else {
          closeNavDropdown(item);
        }
      });
    });

    document.addEventListener("click", function (e) {
      document.querySelectorAll(".nav-dropdown.is-open").forEach(function (item) {
        if (!item.contains(e.target)) closeNavDropdown(item);
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAllNavDropdowns(null);
    });
  }

  /* ===================== FAQ Akkordeon ===================== */

  function initFaq() {
    const questions = document.querySelectorAll(".faq-question");
    questions.forEach(function (btn) {
      btn.addEventListener("click", function () {
        const expanded = btn.getAttribute("aria-expanded") === "true";
        const answer = btn.closest(".faq-item").querySelector(".faq-answer");
        btn.setAttribute("aria-expanded", String(!expanded));
        answer.hidden = expanded;
      });
    });
  }

  /* ===================== Hilfsfunktionen für Ergebnis-Karten ===================== */

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function createResultItem(label, value, modifierClass) {
    const item = document.createElement("div");
    item.className = "result-item" + (modifierClass ? " " + modifierClass : "");
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    item.appendChild(span);
    item.appendChild(strong);
    return item;
  }

  function setTrafficLight(containerEl, dotEl, textEl, status, text) {
    containerEl.classList.remove("status-green", "status-yellow", "status-red");
    containerEl.classList.add("status-" + status);
    textEl.textContent = text;
  }

  /* ======================================================================
     ANNUITÄTENDARLEHEN – Restschuldberechnung
     Monatliche Rate bleibt über die Laufzeit konstant (Annuität).
     In jedem Monat wird der Zinsanteil von der Restschuld berechnet,
     der Rest der Rate tilgt das Darlehen.
     ====================================================================== */

  function calculateRemainingDebt(loanAmount, annualInterestPercent, annualRepaymentPercent, years) {
    if (!isFinite(loanAmount) || loanAmount <= 0) return 0;
    const monthlyInterestRate = annualInterestPercent / 100 / 12;
    const monthlyAnnuity = loanAmount * (annualInterestPercent + annualRepaymentPercent) / 100 / 12;
    let remaining = loanAmount;
    const totalMonths = Math.round(years * 12);

    for (let m = 0; m < totalMonths; m++) {
      const interestPortion = remaining * monthlyInterestRate;
      let principalPortion = monthlyAnnuity - interestPortion;
      if (principalPortion < 0) principalPortion = 0; // Sicherheitsnetz bei unrealistischer Konfiguration
      remaining -= principalPortion;
      if (remaining < 0) remaining = 0;
    }
    return remaining;
  }

  /* ======================================================================
     IMMOBILIEN-SOFORTCHECK – Berechnungskern (reine Funktion)
     ====================================================================== */

  function calculateProperty(inp) {
    if (!isFinite(inp.priceEUR) || inp.priceEUR <= 0) {
      return { error: "Der Kaufpreis muss größer als 0 Euro sein." };
    }
    if (!isFinite(inp.areaSqm) || inp.areaSqm <= 0) {
      return { error: "Die Wohnfläche muss größer als 0 m² sein." };
    }
    if (!isFinite(inp.fixedPeriodYears) || inp.fixedPeriodYears <= 0) {
      return { error: "Die Zinsbindung muss mindestens 1 Jahr betragen." };
    }
    if (!isFinite(inp.equity) || inp.equity < 0) {
      return { error: "Das Eigenkapital darf nicht negativ sein." };
    }
    if (!isFinite(inp.interestRate) || inp.interestRate < 0) {
      return { error: "Der Sollzins darf nicht negativ sein." };
    }
    if (!isFinite(inp.repaymentRate) || inp.repaymentRate <= 0) {
      return { error: "Die anfängliche Tilgung muss größer als 0 % sein." };
    }

    const pricePerSqm = inp.priceEUR / inp.areaSqm;
    const ancillaryCosts = inp.priceEUR * (inp.ancillaryPercent / 100) + inp.priceEUR * (inp.brokerPercent / 100);
    const totalInvestment = inp.priceEUR + ancillaryCosts + inp.renovationBudget;

    let loanAmount = totalInvestment - inp.equity;
    if (loanAmount < 0) loanAmount = 0;

    const annualDebtService = loanAmount * (inp.interestRate + inp.repaymentRate) / 100;
    const monthlyRatePayment = annualDebtService / 12;
    const remainingDebt = calculateRemainingDebt(loanAmount, inp.interestRate, inp.repaymentRate, inp.fixedPeriodYears);

    const maintenanceReserveAnnual = inp.maintenancePerSqm * inp.areaSqm;
    const monthlyFixedRunningCosts = (inp.propertyTaxYear + inp.buildingInsuranceYear) / 12 + maintenanceReserveAnnual / 12 + inp.otherMonth;
    const monthlyRunningCostsOwner = monthlyFixedRunningCosts + (inp.usage === "eigennutzung" ? inp.heatingMonth : 0);
    const monthlyTotalBurden = monthlyRatePayment + monthlyRunningCostsOwner;
    const liquidityReserve = 3 * monthlyTotalBurden;

    const effectiveRent = inp.rent * (1 - inp.vacancyPercent / 100);
    const monthlyCashflow = effectiveRent - inp.nonRecoverable - monthlyRatePayment - monthlyFixedRunningCosts;

    const grossYield = inp.priceEUR > 0 ? (inp.rent * 12 / inp.priceEUR) * 100 : 0;
    const annualNetIncome = effectiveRent * 12 - inp.nonRecoverable * 12 - inp.propertyTaxYear - inp.buildingInsuranceYear - maintenanceReserveAnnual - inp.otherMonth * 12;
    const totalInvestmentYield = totalInvestment > 0 ? (annualNetIncome / totalInvestment) * 100 : 0;
    const purchaseFactor = inp.rent > 0 ? inp.priceEUR / (inp.rent * 12) : null;

    let status, statusText;
    if (inp.usage === "kapitalanlage") {
      if (monthlyCashflow < -150) {
        status = "red"; statusText = "Rechnerisch kritisch – Finanzierung oder Kaufpreis überdenken.";
      } else if (monthlyCashflow < 0) {
        status = "yellow"; statusText = "Erhöhte Belastung – Annahmen genauer prüfen.";
      } else {
        status = "green"; statusText = "Unter den eingegebenen Annahmen rechnerisch solide.";
      }
    } else {
      const equityRatio = totalInvestment > 0 ? (inp.equity / totalInvestment) * 100 : 0;
      if (equityRatio < 10) {
        status = "red"; statusText = "Rechnerisch kritisch – Finanzierung oder Kaufpreis überdenken.";
      } else if (equityRatio < 20) {
        status = "yellow"; statusText = "Erhöhte Belastung – Annahmen genauer prüfen.";
      } else {
        status = "green"; statusText = "Unter den eingegebenen Annahmen rechnerisch solide.";
      }
    }

    return {
      pricePerSqm, ancillaryCosts, totalInvestment, loanAmount, monthlyRatePayment,
      annualDebtService, remainingDebt, maintenanceReserveAnnual, monthlyRunningCostsOwner,
      monthlyTotalBurden, liquidityReserve, monthlyCashflow, grossYield, totalInvestmentYield,
      purchaseFactor, status, statusText, usage: inp.usage
    };
  }

  function readPropertyForm() {
    return {
      priceEUR: parseNumberInput(document.getElementById("p-price")),
      areaSqm: parseNumberInput(document.getElementById("p-area")),
      yearBuilt: parseNumberInput(document.getElementById("p-year")),
      usage: document.getElementById("p-usage").value,
      renovationBudget: parseNumberInput(document.getElementById("p-renovation")) || 0,
      ancillaryPercent: parseNumberInput(document.getElementById("p-ancillary")) || 0,
      brokerPercent: parseNumberInput(document.getElementById("p-broker")) || 0,
      equity: parseNumberInput(document.getElementById("p-equity")) || 0,
      interestRate: parseNumberInput(document.getElementById("p-interest")) || 0,
      repaymentRate: parseNumberInput(document.getElementById("p-repayment")),
      fixedPeriodYears: parseNumberInput(document.getElementById("p-fixedperiod")),
      rent: parseNumberInput(document.getElementById("p-rent")) || 0,
      nonRecoverable: parseNumberInput(document.getElementById("p-nonrecoverable")) || 0,
      vacancyPercent: parseNumberInput(document.getElementById("p-vacancy")) || 0,
      maintenancePerSqm: parseNumberInput(document.getElementById("p-maintenance")) || 0,
      propertyTaxYear: parseNumberInput(document.getElementById("p-propertytax")) || 0,
      buildingInsuranceYear: parseNumberInput(document.getElementById("p-buildinginsurance")) || 0,
      heatingMonth: parseNumberInput(document.getElementById("p-heating")) || 0,
      otherMonth: parseNumberInput(document.getElementById("p-other")) || 0
    };
  }

  function renderPropertyResults(result, objectName) {
    const errorEl = document.getElementById("property-error");
    const resultsEl = document.getElementById("property-results");

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      resultsEl.hidden = true;
      return;
    }
    errorEl.hidden = true;

    const nameEl = document.getElementById("property-object-name");
    if (nameEl) {
      nameEl.textContent = objectName ? " – " + objectName : "";
    }
    resultsEl.dataset.objectName = objectName || "";

    const grid = document.getElementById("property-result-grid");
    clearChildren(grid);

    grid.appendChild(createResultItem("Kaufpreis pro m²", formatEuroCents(result.pricePerSqm)));
    grid.appendChild(createResultItem("Kaufnebenkosten", formatEuro(result.ancillaryCosts)));
    grid.appendChild(createResultItem("Gesamtinvestition", formatEuro(result.totalInvestment)));
    grid.appendChild(createResultItem("Benötigte Darlehenssumme", formatEuro(result.loanAmount)));
    grid.appendChild(createResultItem("Monatliche Kreditrate (anfänglich)", formatEuro(result.monthlyRatePayment)));
    grid.appendChild(createResultItem("Jährliche Zins- und Tilgungsbelastung", formatEuro(result.annualDebtService)));
    grid.appendChild(createResultItem("Restschuld nach Zinsbindung", formatEuro(result.remainingDebt)));
    grid.appendChild(createResultItem("Monatliche laufende Kosten", formatEuro(result.monthlyRunningCostsOwner)));
    grid.appendChild(createResultItem("Monatliche Gesamtbelastung", formatEuro(result.monthlyTotalBurden)));
    grid.appendChild(createResultItem("Empfohlene Liquiditätsreserve", formatEuro(result.liquidityReserve)));
    grid.appendChild(createResultItem("Jährliche Instandhaltungsrücklage", formatEuro(result.maintenanceReserveAnnual)));

    // Rein vermietungsbezogene Kennzahlen nur bei Kapitalanlage anzeigen –
    // bei Eigennutzung sind sie nicht relevant (siehe Vermietungs-Fieldset,
    // das für diesen Fall ebenfalls ausgeblendet wird).
    if (result.usage === "kapitalanlage") {
      grid.appendChild(createResultItem("Bruttomietrendite", formatPercent(result.grossYield)));
      grid.appendChild(createResultItem("Rendite auf Gesamtinvestition", formatPercent(result.totalInvestmentYield)));
      grid.appendChild(createResultItem("Kaufpreisfaktor", result.purchaseFactor !== null ? formatNumber(result.purchaseFactor, 1) + "x" : "–"));
      grid.appendChild(createResultItem(
        "Monatlicher Cashflow vor Steuern",
        formatEuro(result.monthlyCashflow),
        result.monthlyCashflow < 0 ? "negative" : "positive"
      ));
    }

    const trafficEl = document.getElementById("property-traffic");
    setTrafficLight(trafficEl, document.getElementById("property-traffic-dot"), document.getElementById("property-traffic-text"), result.status, result.statusText);

    const wasHidden = resultsEl.hidden;
    resultsEl.hidden = false;
    if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initPropertyCalculator() {
    const form = document.getElementById("property-form");
    if (!form) return;

    const usageSelect = document.getElementById("p-usage");
    const vermietungFieldset = document.getElementById("p-vermietung-fieldset");

    function updatePropertyUsageVisibility() {
      if (!usageSelect || !vermietungFieldset) return;
      vermietungFieldset.hidden = usageSelect.value !== "kapitalanlage";
    }

    function runPropertyCalculation() {
      const inputs = readPropertyForm();
      const result = calculateProperty(inputs);
      const objectNameField = document.getElementById("p-objectname");
      const objectName = objectNameField ? objectNameField.value.trim() : "";
      renderPropertyResults(result, objectName);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      runPropertyCalculation();
    });

    // Live-Neuberechnung, während an einem Schieberegler ("Cursor") gezogen wird.
    form.addEventListener("input", function (e) {
      if (e.target && e.target.type === "range" && !document.getElementById("property-results").hidden) {
        runPropertyCalculation();
      }
    });

    // Bei Eigennutzung sind Mietkennzahlen nicht relevant: Vermietungs-Feld
    // ausblenden und Ergebnis sofort neu berechnen (falls schon eines da ist).
    if (usageSelect) {
      usageSelect.addEventListener("change", function () {
        updatePropertyUsageVisibility();
        if (!document.getElementById("property-results").hidden) {
          runPropertyCalculation();
        }
      });
    }
    updatePropertyUsageVisibility();

    document.getElementById("property-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      updatePropertyUsageVisibility();
      document.getElementById("property-results").hidden = true;
      document.getElementById("property-error").hidden = true;
    });

    document.getElementById("property-print").addEventListener("click", function () {
      if (document.getElementById("property-results").hidden) {
        showModal("Kein Ergebnis vorhanden", "Bitte berechnen Sie zunächst Ihre Immobilie, bevor Sie das Ergebnis drucken.");
        return;
      }
      window.print();
    });
  }

  /* ======================================================================
     E-AUTO-RECHNER – Berechnungskern (reine Funktion)
     ====================================================================== */

  /* Kuratierte Liste gängiger Modelle in Deutschland (keine Live-Datenbank,
     sondern grobe, recherchierte Richtwerte für Verbrauch und Listenpreis,
     Stand 2026 - Modelle, Preise und Verbrauchswerte ändern sich laufend und
     variieren je nach Ausstattung; frei überschreibbar). Zu jedem Verbrenner
     ist ein vergleichbares E-Auto derselben Klasse hinterlegt. */
  const BENZIN_PRICE_DEFAULT = 2.10;
  const DIESEL_PRICE_DEFAULT = 2.15;

  const VEHICLE_MODELS = [
    { id: "vw-golf-benzin", label: "VW Golf 1.5 TSI (Benzin)", type: "ice", fuel: "benzin", consumption: 6.5, price: 29000, comparableEv: "vw-id3" },
    { id: "vw-golf-diesel", label: "VW Golf 2.0 TDI (Diesel)", type: "ice", fuel: "diesel", consumption: 5.0, price: 31000, comparableEv: "vw-id3" },
    { id: "vw-passat-diesel", label: "VW Passat 2.0 TDI (Diesel)", type: "ice", fuel: "diesel", consumption: 5.5, price: 38000, comparableEv: "vw-id7" },
    { id: "vw-tiguan-benzin", label: "VW Tiguan 1.5 TSI (Benzin)", type: "ice", fuel: "benzin", consumption: 7.5, price: 36000, comparableEv: "vw-id4" },
    { id: "bmw-3er-diesel", label: "BMW 320d (Diesel)", type: "ice", fuel: "diesel", consumption: 5.3, price: 47000, comparableEv: "bmw-i4" },
    { id: "mercedes-c-diesel", label: "Mercedes-Benz C 220d (Diesel)", type: "ice", fuel: "diesel", consumption: 5.5, price: 50000, comparableEv: "mercedes-eqa" },
    { id: "skoda-octavia-diesel", label: "Skoda Octavia 2.0 TDI (Diesel)", type: "ice", fuel: "diesel", consumption: 4.9, price: 32000, comparableEv: "skoda-enyaq" },
    { id: "opel-corsa-benzin", label: "Opel Corsa 1.2 (Benzin)", type: "ice", fuel: "benzin", consumption: 5.5, price: 21000, comparableEv: "opel-corsa-e" },
    { id: "audi-a4-diesel", label: "Audi A4 40 TDI (Diesel)", type: "ice", fuel: "diesel", consumption: 5.2, price: 46000, comparableEv: "audi-q4-e-tron" },
    { id: "ford-focus-benzin", label: "Ford Focus 1.0 EcoBoost (Benzin)", type: "ice", fuel: "benzin", consumption: 6.0, price: 27000, comparableEv: "vw-id3" },
    { id: "hyundai-tucson-diesel", label: "Hyundai Tucson 1.6 CRDi (Diesel)", type: "ice", fuel: "diesel", consumption: 5.8, price: 33000, comparableEv: "hyundai-kona-elektro" },
    { id: "vw-id3", label: "VW ID.3", type: "ev", consumption: 15.5, price: 39000 },
    { id: "vw-id4", label: "VW ID.4", type: "ev", consumption: 17.5, price: 43000 },
    { id: "vw-id7", label: "VW ID.7", type: "ev", consumption: 16.0, price: 57000 },
    { id: "tesla-model3", label: "Tesla Model 3", type: "ev", consumption: 14.5, price: 42000 },
    { id: "tesla-modely", label: "Tesla Model Y", type: "ev", consumption: 15.5, price: 45000 },
    { id: "bmw-i4", label: "BMW i4", type: "ev", consumption: 16.5, price: 55000 },
    { id: "mercedes-eqa", label: "Mercedes-Benz EQA", type: "ev", consumption: 17.0, price: 48000 },
    { id: "skoda-enyaq", label: "Skoda Enyaq", type: "ev", consumption: 16.5, price: 42000 },
    { id: "opel-corsa-e", label: "Opel Corsa-e", type: "ev", consumption: 15.5, price: 30000 },
    { id: "audi-q4-e-tron", label: "Audi Q4 e-tron", type: "ev", consumption: 17.5, price: 48000 },
    { id: "hyundai-kona-elektro", label: "Hyundai Kona Elektro", type: "ev", consumption: 14.7, price: 36000 },
    { id: "renault-zoe", label: "Renault Zoe", type: "ev", consumption: 15.0, price: 32000 },
    { id: "fiat-500e", label: "Fiat 500e", type: "ev", consumption: 14.0, price: 28000 }
  ];

  function findVehicleModel(id) {
    return VEHICLE_MODELS.filter(function (m) { return m.id === id; })[0] || null;
  }

  function calculateEv(inp) {
    const errors = [];

    const numericFields = [
      "annualKm", "holdingYears", "priceEV", "priceICE", "residualEV", "residualICE",
      "wallbox", "subsidy", "evConsumption", "homeShare", "homePrice", "publicShare",
      "publicPrice", "pvShare", "pvPrice", "insuranceEV", "taxEV", "maintenanceEV",
      "iceConsumption", "fuelPrice", "insuranceICE", "taxICE", "maintenanceICE"
    ];
    for (const key of numericFields) {
      if (!isFinite(inp[key])) {
        errors.push("Bitte füllen Sie alle Felder mit gültigen Zahlen aus.");
        break;
      }
    }
    if (errors.length === 0 && numericFields.some(k => inp[k] < 0)) {
      errors.push("Es dürfen keine negativen Werte eingegeben werden.");
    }
    if (errors.length === 0 && inp.holdingYears < 1) {
      errors.push("Die Haltedauer muss mindestens 1 Jahr betragen.");
    }
    if (errors.length === 0 && inp.annualKm <= 0) {
      errors.push("Die jährliche Fahrleistung muss größer als 0 km sein.");
    }
    if (errors.length === 0) {
      const shareSum = Math.round((inp.homeShare + inp.publicShare + inp.pvShare) * 100) / 100;
      if (shareSum !== 100) {
        errors.push("Die Ladeanteile aus Zuhause, öffentlich und PV-Anlage müssen zusammen genau 100 % ergeben (aktuell " + formatNumber(shareSum, 1) + " %).");
      }
    }

    if (errors.length > 0) return { error: errors.join(" ") };

    const weightedElectricityPrice =
      (inp.homeShare / 100) * inp.homePrice +
      (inp.publicShare / 100) * inp.publicPrice +
      (inp.pvShare / 100) * inp.pvPrice;

    const annualElectricityConsumptionKwh = inp.annualKm / 100 * inp.evConsumption;
    const annualElectricityCost = inp.annualKm / 100 * inp.evConsumption * weightedElectricityPrice;
    const annualOperatingCostsEV = annualElectricityCost + inp.insuranceEV + inp.taxEV + inp.maintenanceEV;

    // Ersparnis durch Laden aus eigener PV-Anlage: Vergleich mit einem Szenario,
    // in dem der PV-Ladeanteil stattdessen zu Hause aus dem Netz geladen würde.
    const weightedPriceWithoutPv =
      ((inp.homeShare + inp.pvShare) / 100) * inp.homePrice +
      (inp.publicShare / 100) * inp.publicPrice;
    const pvSavingsAnnual = inp.annualKm / 100 * inp.evConsumption * (weightedPriceWithoutPv - weightedElectricityPrice);
    const pvSavingsTotal = pvSavingsAnnual * inp.holdingYears;

    const totalCostEV = inp.priceEV + inp.wallbox - inp.subsidy
      + annualElectricityCost * inp.holdingYears
      + inp.insuranceEV * inp.holdingYears
      + inp.taxEV * inp.holdingYears
      + inp.maintenanceEV * inp.holdingYears
      - inp.residualEV;

    const monthlyCostEV = totalCostEV / (inp.holdingYears * 12);
    const perKmCostEV = totalCostEV / (inp.annualKm * inp.holdingYears);

    const annualFuelConsumptionLiters = inp.annualKm / 100 * inp.iceConsumption;
    const annualFuelCost = inp.annualKm / 100 * inp.iceConsumption * inp.fuelPrice;
    const annualOperatingCostsICE = annualFuelCost + inp.insuranceICE + inp.taxICE + inp.maintenanceICE;

    const totalCostICE = inp.priceICE
      + annualFuelCost * inp.holdingYears
      + inp.insuranceICE * inp.holdingYears
      + inp.taxICE * inp.holdingYears
      + inp.maintenanceICE * inp.holdingYears
      - inp.residualICE;

    const monthlyCostICE = totalCostICE / (inp.holdingYears * 12);
    const perKmCostICE = totalCostICE / (inp.annualKm * inp.holdingYears);

    const totalDifference = totalCostICE - totalCostEV; // positiv = E-Auto günstiger
    const monthlyDifference = totalDifference / (inp.holdingYears * 12);
    const perKmDifference = perKmCostICE - perKmCostEV;
    const annualOperatingSavings = annualOperatingCostsICE - annualOperatingCostsEV;

    // Break-even-Berechnung: wann gleicht sich die höhere Anschaffung des E-Autos
    // durch niedrigere laufende Kosten aus?
    const fixedEV = inp.priceEV + inp.wallbox - inp.subsidy;
    const fixedICE = inp.priceICE;
    const fixedDiff = fixedEV - fixedICE;
    const opDiffPerYear = annualOperatingCostsICE - annualOperatingCostsEV;

    let breakEvenYears = null;
    let breakEvenReached = true;
    let breakEvenNote = "";

    if (fixedDiff <= 0 && opDiffPerYear >= 0) {
      breakEvenYears = 0;
    } else if (opDiffPerYear <= 0) {
      breakEvenReached = false;
      breakEvenNote = "Innerhalb der gewählten Haltedauer wird unter diesen Annahmen kein Break-even erreicht, da die laufenden Kosten des Elektroautos nicht niedriger sind.";
    } else {
      const be = fixedDiff / opDiffPerYear;
      if (!isFinite(be)) {
        breakEvenReached = false;
        breakEvenNote = "Der Break-even kann mit diesen Werten nicht sinnvoll berechnet werden.";
      } else if (be <= 0) {
        breakEvenYears = 0;
      } else if (be > inp.holdingYears) {
        breakEvenReached = false;
        breakEvenYears = be;
        breakEvenNote = "Innerhalb der gewählten Haltedauer von " + inp.holdingYears + " Jahren wird unter diesen Annahmen kein Break-even erreicht (rechnerisch nach rund " + formatNumber(be, 1) + " Jahren).";
      } else {
        breakEvenYears = be;
      }
    }

    let status, statusText;
    if (totalDifference > 500) {
      status = "green"; statusText = "Unter den eingegebenen Annahmen ist das Elektroauto über die Haltedauer günstiger.";
    } else if (totalDifference > -500) {
      status = "yellow"; statusText = "Die Gesamtkosten liegen unter den eingegebenen Annahmen nah beieinander.";
    } else {
      status = "red"; statusText = "Unter den eingegebenen Annahmen ist der Verbrenner über die Haltedauer günstiger.";
    }

    return {
      weightedElectricityPrice, annualElectricityConsumptionKwh, annualElectricityCost, annualOperatingCostsEV,
      pvSavingsAnnual, pvSavingsTotal,
      totalCostEV, monthlyCostEV, perKmCostEV,
      annualFuelConsumptionLiters, annualFuelCost, annualOperatingCostsICE,
      totalCostICE, monthlyCostICE, perKmCostICE,
      totalDifference, monthlyDifference, perKmDifference, annualOperatingSavings,
      breakEvenYears, breakEvenReached, breakEvenNote,
      status, statusText
    };
  }

  function readEvForm() {
    return {
      annualKm: parseNumberInput(document.getElementById("e-km")),
      holdingYears: parseNumberInput(document.getElementById("e-years")),
      priceEV: parseNumberInput(document.getElementById("e-priceev")),
      priceICE: parseNumberInput(document.getElementById("e-priceice")),
      residualEV: parseNumberInput(document.getElementById("e-residualev")),
      residualICE: parseNumberInput(document.getElementById("e-residualice")),
      wallbox: parseNumberInput(document.getElementById("e-wallbox")),
      subsidy: parseNumberInput(document.getElementById("e-subsidy")),
      evConsumption: parseNumberInput(document.getElementById("e-consumption")),
      homeShare: parseNumberInput(document.getElementById("e-homeshare")),
      homePrice: parseNumberInput(document.getElementById("e-homeprice")),
      publicShare: parseNumberInput(document.getElementById("e-publicshare")),
      publicPrice: parseNumberInput(document.getElementById("e-publicprice")),
      pvShare: parseNumberInput(document.getElementById("e-pvshare")),
      pvPrice: parseNumberInput(document.getElementById("e-pvprice")),
      insuranceEV: parseNumberInput(document.getElementById("e-insurance")),
      taxEV: parseNumberInput(document.getElementById("e-tax")),
      maintenanceEV: parseNumberInput(document.getElementById("e-maintenance")),
      iceConsumption: parseNumberInput(document.getElementById("i-consumption")),
      fuelPrice: parseNumberInput(document.getElementById("i-fuelprice")),
      insuranceICE: parseNumberInput(document.getElementById("i-insurance")),
      taxICE: parseNumberInput(document.getElementById("i-tax")),
      maintenanceICE: parseNumberInput(document.getElementById("i-maintenance")),
      currentCarName: (document.getElementById("e-currentcar") ? document.getElementById("e-currentcar").value.trim() : "")
    };
  }

  function renderEvBarChart(result) {
    const container = document.getElementById("ev-bar-chart");
    clearChildren(container);

    const maxValue = Math.max(result.totalCostEV, result.totalCostICE, 1);

    function buildRow(label, value, cssClass) {
      const row = document.createElement("div");
      row.className = "bar-row";

      const labelRow = document.createElement("div");
      labelRow.className = "bar-row-label";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = label;
      const valSpan = document.createElement("span");
      valSpan.textContent = formatEuro(value);
      labelRow.appendChild(nameSpan);
      labelRow.appendChild(valSpan);

      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill " + cssClass;
      const pct = Math.max(0, Math.min(100, (value / maxValue) * 100));
      fill.style.width = pct + "%";
      track.appendChild(fill);

      row.appendChild(labelRow);
      row.appendChild(track);
      return row;
    }

    container.appendChild(buildRow("Gesamtkosten Elektroauto über Haltedauer", result.totalCostEV, "ev"));
    container.appendChild(buildRow("Gesamtkosten Verbrenner über Haltedauer", result.totalCostICE, "ice"));
  }

  function renderEvResults(result, holdingYears, currentCarName) {
    const errorEl = document.getElementById("ev-error");
    const resultsEl = document.getElementById("ev-results");

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      resultsEl.hidden = true;
      return;
    }
    errorEl.hidden = true;

    const iceTitleEl = document.getElementById("ev-ice-title");
    if (iceTitleEl) {
      iceTitleEl.textContent = currentCarName ? "Verbrenner (" + currentCarName + ")" : "Verbrenner";
    }

    const gridEv = document.getElementById("ev-result-ev");
    clearChildren(gridEv);
    gridEv.appendChild(createResultItem("Gewichteter Strompreis", formatEuroCents(result.weightedElectricityPrice) + " / kWh"));
    gridEv.appendChild(createResultItem("Stromverbrauch pro Jahr", formatNumber(result.annualElectricityConsumptionKwh, 0) + " kWh"));
    gridEv.appendChild(createResultItem("Stromkosten pro Jahr", formatEuro(result.annualElectricityCost)));
    gridEv.appendChild(createResultItem("Betriebskosten pro Jahr", formatEuro(result.annualOperatingCostsEV)));
    gridEv.appendChild(createResultItem("Gesamtkosten über Haltedauer", formatEuro(result.totalCostEV)));
    gridEv.appendChild(createResultItem("Gesamtkosten pro Monat", formatEuro(result.monthlyCostEV)));
    gridEv.appendChild(createResultItem("Gesamtkosten pro km", formatEuroCents(result.perKmCostEV)));
    gridEv.appendChild(createResultItem(
      "Ersparnis durch eigene PV-Anlage pro Jahr",
      formatEuro(result.pvSavingsAnnual),
      result.pvSavingsAnnual >= 0 ? "positive" : "negative"
    ));
    gridEv.appendChild(createResultItem(
      "Ersparnis durch eigene PV-Anlage über Haltedauer",
      formatEuro(result.pvSavingsTotal),
      result.pvSavingsTotal >= 0 ? "positive" : "negative"
    ));

    const gridIce = document.getElementById("ev-result-ice");
    clearChildren(gridIce);
    gridIce.appendChild(createResultItem("Kraftstoffverbrauch pro Jahr", formatNumber(result.annualFuelConsumptionLiters, 0) + " l"));
    gridIce.appendChild(createResultItem("Kraftstoffkosten pro Jahr", formatEuro(result.annualFuelCost)));
    gridIce.appendChild(createResultItem("Betriebskosten pro Jahr", formatEuro(result.annualOperatingCostsICE)));
    gridIce.appendChild(createResultItem("Gesamtkosten über Haltedauer", formatEuro(result.totalCostICE)));
    gridIce.appendChild(createResultItem("Gesamtkosten pro Monat", formatEuro(result.monthlyCostICE)));
    gridIce.appendChild(createResultItem("Gesamtkosten pro km", formatEuroCents(result.perKmCostICE)));

    renderEvBarChart(result);

    const gridCompare = document.getElementById("ev-result-compare");
    clearChildren(gridCompare);
    gridCompare.appendChild(createResultItem(
      "Ersparnis pro Monat mit Elektroauto",
      formatEuro(result.monthlyDifference),
      (result.monthlyDifference >= 0 ? "positive" : "negative") + " highlight"
    ));
    gridCompare.appendChild(createResultItem(
      "Ersparnis über die gesamte Haltedauer",
      formatEuro(result.totalDifference),
      (result.totalDifference >= 0 ? "positive" : "negative") + " highlight"
    ));
    gridCompare.appendChild(createResultItem("Kostenunterschied pro km", formatEuroCents(result.perKmDifference)));
    gridCompare.appendChild(createResultItem("Jährliche Betriebskostenersparnis", formatEuro(result.annualOperatingSavings)));

    let breakEvenText;
    if (result.breakEvenYears === null) {
      breakEvenText = "Nicht ermittelbar";
    } else if (!result.breakEvenReached) {
      breakEvenText = "Kein Break-even in " + holdingYears + " Jahren";
    } else {
      breakEvenText = formatNumber(result.breakEvenYears, 1) + " Jahre";
    }
    gridCompare.appendChild(createResultItem("Ungefährer Break-even-Zeitpunkt", breakEvenText));

    let breakEvenNoteEl = document.getElementById("ev-breakeven-note");
    if (!breakEvenNoteEl) {
      breakEvenNoteEl = document.createElement("p");
      breakEvenNoteEl.id = "ev-breakeven-note";
      breakEvenNoteEl.className = "field-hint";
      gridCompare.insertAdjacentElement("afterend", breakEvenNoteEl);
    }
    breakEvenNoteEl.textContent = result.breakEvenNote || "";
    breakEvenNoteEl.hidden = !result.breakEvenNote;

    const trafficEl = document.getElementById("ev-traffic");
    setTrafficLight(trafficEl, document.getElementById("ev-traffic-dot"), document.getElementById("ev-traffic-text"), result.status, result.statusText);

    saveStammdaten({ evMonthlySavings: Math.round(result.monthlyDifference) });
    const evStammHint = document.getElementById("ev-stammdaten-hint");
    if (evStammHint) evStammHint.hidden = false;

    const wasHidden = resultsEl.hidden;
    resultsEl.hidden = false;
    if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initEvCalculator() {
    const form = document.getElementById("ev-form");
    if (!form) return;

    function runEvCalculation() {
      const inputs = readEvForm();
      const result = calculateEv(inputs);
      renderEvResults(result, inputs.holdingYears, inputs.currentCarName);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      runEvCalculation();
    });

    form.addEventListener("input", function (e) {
      if (e.target && e.target.type === "range" && !document.getElementById("ev-results").hidden) {
        runEvCalculation();
      }
    });

    // Modellfinder: aktuelles Fahrzeug wählen -> Verbrauch, Kraftstoff-/Strompreis
    // und Kaufpreis automatisch eintragen, inkl. passendem Vergleichsfahrzeug.
    // Nur Felder überschreiben, die der Nutzer noch nicht selbst angefasst hat.
    const modelFinder = document.getElementById("e-model-finder");
    const currentCarInput = document.getElementById("e-currentcar");
    const modelHint = document.getElementById("e-model-hint");
    const autoFillIds = ["e-priceev", "e-priceice", "e-consumption", "i-consumption", "i-fuelprice"];

    autoFillIds.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", function () { el.dataset.touched = "true"; });
    });

    function setIfUntouched(id, value) {
      const el = document.getElementById(id);
      if (el && el.dataset.touched !== "true") setSliderValue(id, value);
    }

    if (modelFinder) {
      modelFinder.addEventListener("change", function () {
        const model = findVehicleModel(modelFinder.value);
        if (!model) return;

        if (currentCarInput) currentCarInput.value = model.label;

        if (model.type === "ice") {
          setIfUntouched("i-consumption", model.consumption);
          setIfUntouched("i-fuelprice", model.fuel === "diesel" ? DIESEL_PRICE_DEFAULT : BENZIN_PRICE_DEFAULT);
          setIfUntouched("e-priceice", model.price);
          const comparableEv = findVehicleModel(model.comparableEv);
          if (comparableEv) {
            setIfUntouched("e-priceev", comparableEv.price);
            setIfUntouched("e-consumption", comparableEv.consumption);
            if (modelHint) {
              modelHint.textContent = "Passendes Vergleichsfahrzeug automatisch gewählt: " + comparableEv.label + ". Alle Werte bleiben frei anpassbar.";
              modelHint.hidden = false;
            }
          }
        } else {
          setIfUntouched("e-priceev", model.price);
          setIfUntouched("e-consumption", model.consumption);
          if (modelHint) {
            modelHint.textContent = "Werte für " + model.label + " übernommen. Alle Werte bleiben frei anpassbar.";
            modelHint.hidden = false;
          }
        }

        if (!document.getElementById("ev-results").hidden) runEvCalculation();
      });
    }

    document.getElementById("ev-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      autoFillIds.forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.dataset.touched = "false";
      });
      if (modelHint) {
        modelHint.textContent = "Wählen Sie Ihr aktuelles Fahrzeug – Verbrauch, Kraftstoffpreis und Kaufpreis werden automatisch eingetragen, inklusive eines passenden Vergleichs-E-Autos. Alle Werte bleiben frei anpassbar.";
        modelHint.hidden = false;
      }
      document.getElementById("ev-results").hidden = true;
      document.getElementById("ev-error").hidden = true;
    });

    document.getElementById("ev-print").addEventListener("click", function () {
      if (document.getElementById("ev-results").hidden) {
        showModal("Kein Ergebnis vorhanden", "Bitte führen Sie zunächst den Vergleich durch, bevor Sie das Ergebnis drucken.");
        return;
      }
      window.print();
    });
  }

  /* ======================================================================
     PV-RECHNER MIT SPEICHER – Berechnungskern (reine Funktion)
     Vergleicht eine PV-Anlage ohne und mit Batteriespeicher: Eigenverbrauch,
     Netzeinspeisung, Autarkiegrad, jährlicher finanzieller Vorteil und eine
     einfache (nicht diskontierte) Amortisationsrechnung.
     ====================================================================== */

  function calculatePvScenario(annualYieldKwh, consumptionKwh, selfUsePercent, price, feedIn, investment, maintenance, years) {
    const selfConsumptionKwh = Math.min(annualYieldKwh * (selfUsePercent / 100), consumptionKwh);
    const feedInKwh = Math.max(annualYieldKwh - selfConsumptionKwh, 0);
    const gridPurchaseKwh = Math.max(consumptionKwh - selfConsumptionKwh, 0);
    const selfConsumptionSavings = selfConsumptionKwh * price;
    const feedInRevenue = feedInKwh * feedIn;
    const annualBenefit = selfConsumptionSavings + feedInRevenue - maintenance;
    const selfSufficiencyPercent = consumptionKwh > 0 ? (selfConsumptionKwh / consumptionKwh) * 100 : 0;
    const paybackYears = (investment > 0 && annualBenefit > 0) ? investment / annualBenefit : null;
    const netBenefitOverPeriod = annualBenefit * years - investment;
    const roiPercent = investment > 0 ? (annualBenefit / investment) * 100 : null;

    return {
      selfConsumptionKwh, feedInKwh, gridPurchaseKwh, selfConsumptionSavings, feedInRevenue,
      monthlyFeedInRevenue: feedInRevenue / 12,
      annualBenefit, monthlyBenefit: annualBenefit / 12,
      selfSufficiencyPercent, paybackYears, netBenefitOverPeriod, investment, roiPercent
    };
  }

  /* Reine Auto-Vorschlagsfunktionen (kein I/O), analog zu den anderen
     Rechnern: so viel wie möglich automatisch vorschlagen, alles bleibt
     frei überschreibbar. */
  const EV_DEFAULT_CONSUMPTION_KWH_PER_100KM = 17;

  function estimatePvConsumption(persons, hasEcar, ecarKm) {
    const p = Math.max(1, Math.min(7, Math.round(isFinite(persons) ? persons : 2)));
    const base = ENERGY_BENCHMARKS.strom.consumptionByPersons[p] || ENERGY_BENCHMARKS.strom.consumptionByPersons[2];
    let total = base;
    if (hasEcar && isFinite(ecarKm) && ecarKm > 0) {
      total += (ecarKm / 100) * EV_DEFAULT_CONSUMPTION_KWH_PER_100KM;
    }
    return Math.round(total / 50) * 50;
  }

  /* Grobe Schätzung der Investitionskosten je nach Anlagen-/Speichergröße:
     kleinere Anlagen sind pro kWp/kWh teurer, größere günstiger (Skaleneffekt).
     Grundlage: marktübliche Näherungswerte für schlüsselfertige Wohngebäude-
     Anlagen in Deutschland, Stand 2026 (grobe Richtwerte, keine Angebote). */
  function estimatePvInvestment(kwp) {
    if (!isFinite(kwp) || kwp <= 0) return 0;
    const pricePerKwp = 1050 + 3250 / (kwp + 1.2);
    return Math.round((kwp * pricePerKwp) / 100) * 100;
  }

  function estimatePvBatteryInvestment(batteryKwh) {
    if (!isFinite(batteryKwh) || batteryKwh <= 0) return 0;
    const pricePerKwh = 700 + 1500 / (batteryKwh + 2);
    return Math.round((batteryKwh * pricePerKwh) / 100) * 100;
  }

  /* Grobe, automatische Schätzung des Eigenverbrauchsanteils anhand des
     Verhältnisses von Jahresertrag zu Jahresverbrauch (kleine Anlage relativ
     zum Verbrauch => hoher Eigenverbrauch, große Anlage => niedrigerer
     Eigenverbrauch) sowie – mit Speicher – anhand der Speichergröße relativ
     zum täglichen Verbrauch. Reine Modellschätzung, kein Lastgang. */
  function estimateSelfConsumptionPercent(annualYieldKwh, consumptionKwh, batterySizeKwh) {
    if (!isFinite(annualYieldKwh) || annualYieldKwh <= 0 || !isFinite(consumptionKwh) || consumptionKwh <= 0) {
      return { withoutBattery: 30, withBattery: 30 };
    }
    const ratio = annualYieldKwh / consumptionKwh;
    let withoutBattery = 20 + 55 / (1 + ratio);
    withoutBattery = Math.max(15, Math.min(75, withoutBattery));

    let withBattery = withoutBattery;
    if (isFinite(batterySizeKwh) && batterySizeKwh > 0) {
      const dailyConsumption = consumptionKwh / 365;
      const relativeBatterySize = dailyConsumption > 0 ? batterySizeKwh / dailyConsumption : 0;
      const boost = 35 * (1 - Math.exp(-relativeBatterySize / 1.2));
      withBattery = Math.min(90, withoutBattery + boost);
    }

    return { withoutBattery, withBattery };
  }

  function calculatePv(inp) {
    if (!isFinite(inp.consumption) || inp.consumption <= 0) {
      return { error: "Der jährliche Stromverbrauch muss größer als 0 kWh sein." };
    }
    if (!isFinite(inp.kwp) || inp.kwp <= 0) {
      return { error: "Die PV-Anlagengröße muss größer als 0 kWp sein." };
    }
    if (!isFinite(inp.years) || inp.years < 1) {
      return { error: "Der Betrachtungszeitraum muss mindestens 1 Jahr betragen." };
    }
    const nonNegativeFields = [inp.investment, inp.maintenance, inp.batterySize, inp.batteryInvestment, inp.price, inp.feedIn];
    if (nonNegativeFields.some(v => !isFinite(v) || v < 0)) {
      return { error: "Es dürfen keine negativen Werte eingegeben werden." };
    }

    const specificYield = estimatePvYieldFromZip(inp.zip) || DEFAULT_PV_YIELD;
    const annualYieldKwh = inp.kwp * specificYield;
    const selfUse = estimateSelfConsumptionPercent(annualYieldKwh, inp.consumption, inp.batterySize);

    const withoutBattery = calculatePvScenario(
      annualYieldKwh, inp.consumption, selfUse.withoutBattery, inp.price, inp.feedIn,
      inp.investment, inp.maintenance, inp.years
    );

    let withBattery = null;
    let comparison = null;

    if (inp.batterySize > 0) {
      const totalInvestment = inp.investment + inp.batteryInvestment;
      withBattery = calculatePvScenario(
        annualYieldKwh, inp.consumption, selfUse.withBattery, inp.price, inp.feedIn,
        totalInvestment, inp.maintenance, inp.years
      );

      const additionalInvestment = inp.batteryInvestment;
      const additionalAnnualBenefit = withBattery.annualBenefit - withoutBattery.annualBenefit;
      const batteryPaybackYears = additionalAnnualBenefit > 0 ? additionalInvestment / additionalAnnualBenefit : null;
      const additionalSelfSufficiencyPoints = withBattery.selfSufficiencyPercent - withoutBattery.selfSufficiencyPercent;

      comparison = { additionalInvestment, additionalAnnualBenefit, batteryPaybackYears, additionalSelfSufficiencyPoints };
    }

    const leadScenario = withBattery || withoutBattery;
    let status, statusText;
    if (leadScenario.paybackYears !== null && leadScenario.paybackYears <= 14) {
      status = "green"; statusText = "Unter den eingegebenen Annahmen rechnerisch attraktiv.";
    } else if (leadScenario.paybackYears !== null && leadScenario.paybackYears <= 22) {
      status = "yellow"; statusText = "Erhöhte Amortisationsdauer – Annahmen genauer prüfen.";
    } else {
      status = "red"; statusText = "Rechnerisch kritisch – Investition, Ertrag oder Strompreis überdenken.";
    }

    return {
      specificYield, annualYieldKwh,
      selfUsePercentWithoutBattery: selfUse.withoutBattery, selfUsePercentWithBattery: selfUse.withBattery,
      withoutBattery, withBattery, comparison, status, statusText
    };
  }

  function readPvForm() {
    return {
      consumption: parseNumberInput(document.getElementById("pv-consumption")),
      kwp: parseNumberInput(document.getElementById("pv-kwp")),
      zip: (document.getElementById("pv-zip").value || "").trim(),
      investment: parseNumberInput(document.getElementById("pv-investment")),
      maintenance: parseNumberInput(document.getElementById("pv-maintenance")) || 0,
      batterySize: parseNumberInput(document.getElementById("pv-battery-size")) || 0,
      batteryInvestment: parseNumberInput(document.getElementById("pv-battery-investment")) || 0,
      price: parseNumberInput(document.getElementById("pv-price")),
      feedIn: parseNumberInput(document.getElementById("pv-feedin")),
      years: parseNumberInput(document.getElementById("pv-years"))
    };
  }

  function renderPvScenarioHighlight(gridEl, scenario) {
    clearChildren(gridEl);
    gridEl.appendChild(createResultItem("Ersparnis pro Monat", formatEuro(scenario.monthlyBenefit), (scenario.monthlyBenefit >= 0 ? "positive" : "negative") + " highlight"));
    gridEl.appendChild(createResultItem("Ersparnis pro Jahr", formatEuro(scenario.annualBenefit), (scenario.annualBenefit >= 0 ? "positive" : "negative") + " highlight"));
    gridEl.appendChild(createResultItem("Rendite pro Jahr", scenario.roiPercent !== null ? formatPercent(scenario.roiPercent, 1) : "–", "highlight"));
  }

  function renderPvScenarioDetail(gridEl, scenario, selfUsePercent) {
    clearChildren(gridEl);
    gridEl.appendChild(createResultItem("Automatisch geschätzter Eigenverbrauchsanteil", formatPercent(selfUsePercent, 0)));
    gridEl.appendChild(createResultItem("Eigenverbrauch pro Jahr", formatNumber(scenario.selfConsumptionKwh, 0) + " kWh"));
    gridEl.appendChild(createResultItem("Einspeisung pro Jahr", formatNumber(scenario.feedInKwh, 0) + " kWh"));
    gridEl.appendChild(createResultItem("Netzbezug pro Jahr", formatNumber(scenario.gridPurchaseKwh, 0) + " kWh"));
    gridEl.appendChild(createResultItem("Autarkiegrad", formatPercent(scenario.selfSufficiencyPercent)));
    gridEl.appendChild(createResultItem("Ersparnis durch Eigenverbrauch (Jahr)", formatEuro(scenario.selfConsumptionSavings)));
    gridEl.appendChild(createResultItem("Einspeiseerlös pro Monat", formatEuro(scenario.monthlyFeedInRevenue)));
    gridEl.appendChild(createResultItem("Einspeiseerlös pro Jahr", formatEuro(scenario.feedInRevenue)));
    gridEl.appendChild(createResultItem("Amortisationsdauer", scenario.paybackYears !== null ? formatNumber(scenario.paybackYears, 1) + " Jahre" : "Nicht berechenbar"));
    gridEl.appendChild(createResultItem("Ergebnis über Betrachtungszeitraum", formatEuro(scenario.netBenefitOverPeriod), scenario.netBenefitOverPeriod >= 0 ? "positive" : "negative"));
  }

  function renderPvResults(result) {
    const errorEl = document.getElementById("pv-error");
    const resultsEl = document.getElementById("pv-results");

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      resultsEl.hidden = true;
      return;
    }
    errorEl.hidden = true;

    document.getElementById("pv-yield-total").textContent =
      "Automatisch geschätzter spezifischer Ertrag: " + formatNumber(result.specificYield, 0) + " kWh/kWp/Jahr · " +
      "Geschätzter Jahresertrag Ihrer Anlage: " + formatNumber(result.annualYieldKwh, 0) + " kWh";

    const yieldDisplay = document.getElementById("pv-yield-display");
    if (yieldDisplay) yieldDisplay.textContent = formatNumber(result.specificYield, 0) + " kWh/kWp/Jahr";

    renderPvScenarioHighlight(document.getElementById("pv-highlight-nobattery"), result.withoutBattery);
    renderPvScenarioDetail(document.getElementById("pv-detail-nobattery"), result.withoutBattery, result.selfUsePercentWithoutBattery);

    const batterySection = document.getElementById("pv-battery-section");
    const compareSection = document.getElementById("pv-compare-section");

    if (result.withBattery) {
      batterySection.hidden = false;
      renderPvScenarioHighlight(document.getElementById("pv-highlight-battery"), result.withBattery);
      renderPvScenarioDetail(document.getElementById("pv-detail-battery"), result.withBattery, result.selfUsePercentWithBattery);

      compareSection.hidden = false;
      const compareGrid = document.getElementById("pv-result-compare");
      clearChildren(compareGrid);
      compareGrid.appendChild(createResultItem("Rendite ohne Speicher", result.withoutBattery.roiPercent !== null ? formatPercent(result.withoutBattery.roiPercent, 1) : "–", "highlight"));
      compareGrid.appendChild(createResultItem("Rendite mit Speicher", result.withBattery.roiPercent !== null ? formatPercent(result.withBattery.roiPercent, 1) : "–", "highlight"));
      compareGrid.appendChild(createResultItem("Zusätzliche Investition Speicher", formatEuro(result.comparison.additionalInvestment)));
      compareGrid.appendChild(createResultItem(
        "Zusätzlicher Vorteil durch Speicher pro Monat",
        formatEuro(result.comparison.additionalAnnualBenefit / 12),
        result.comparison.additionalAnnualBenefit >= 0 ? "positive" : "negative"
      ));
      compareGrid.appendChild(createResultItem(
        "Zusätzlicher Vorteil durch Speicher pro Jahr",
        formatEuro(result.comparison.additionalAnnualBenefit),
        result.comparison.additionalAnnualBenefit >= 0 ? "positive" : "negative"
      ));
      compareGrid.appendChild(createResultItem(
        "Amortisation des Speichers (isoliert)",
        result.comparison.batteryPaybackYears !== null ? formatNumber(result.comparison.batteryPaybackYears, 1) + " Jahre" : "Nicht berechenbar"
      ));
      compareGrid.appendChild(createResultItem("Zusätzlicher Autarkiegrad", (result.comparison.additionalSelfSufficiencyPoints >= 0 ? "+" : "") + formatPercent(result.comparison.additionalSelfSufficiencyPoints)));
    } else {
      batterySection.hidden = true;
      compareSection.hidden = true;
    }

    const trafficEl = document.getElementById("pv-traffic");
    setTrafficLight(trafficEl, document.getElementById("pv-traffic-dot"), document.getElementById("pv-traffic-text"), result.status, result.statusText);

    const leadScenario = result.withBattery || result.withoutBattery;
    saveStammdaten({ pvMonthlyBenefit: Math.round(leadScenario.monthlyBenefit) });
    const pvStammHint = document.getElementById("pv-stammdaten-hint");
    if (pvStammHint) pvStammHint.hidden = false;

    const wasHidden = resultsEl.hidden;
    resultsEl.hidden = false;
    if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* Grobe regionale Ertragsschätzung anhand der ersten PLZ-Ziffer. Deutschland
     erhält im Süden spürbar mehr Globalstrahlung als im Norden/Osten. Dies ist
     ein vereinfachter Schätzwert und ersetzt keine Standort-Einzelprüfung
     (Ausrichtung, Neigung, Verschattung werden nicht berücksichtigt). */
  const PV_YIELD_BY_ZIP_PREFIX = {
    "0": 980, "1": 970, "2": 900, "3": 930, "4": 940,
    "5": 960, "6": 980, "7": 1050, "8": 1080, "9": 1020
  };

  /* Bundesweiter Durchschnittswert, der verwendet wird, solange keine
     erkennbare Postleitzahl eingegeben wurde (Mittelwert der Regionstabelle). */
  const DEFAULT_PV_YIELD = 980;

  function estimatePvYieldFromZip(zip) {
    if (!/^\d{5}$/.test(zip || "")) return null;
    return PV_YIELD_BY_ZIP_PREFIX[zip.charAt(0)] || null;
  }

  function initPvCalculator() {
    const form = document.getElementById("pv-form");
    if (!form) return;

    function runPvCalculation() {
      const inputs = readPvForm();
      const result = calculatePv(inputs);
      renderPvResults(result);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      runPvCalculation();
    });

    form.addEventListener("input", function (e) {
      if (e.target && (e.target.type === "range" || e.target.type === "checkbox") && !document.getElementById("pv-results").hidden) {
        runPvCalculation();
      }
    });

    // Automatische Vorschläge für Verbrauch (Personen + optional E-Auto)
    // sowie Investitionskosten (Anlagen-/Speichergröße) - nur solange der
    // Nutzer das jeweilige Feld noch nicht selbst angefasst hat.
    const personsInput = document.getElementById("pv-persons");
    const ecarCheck = document.getElementById("pv-ecar");
    const ecarKmField = document.getElementById("pv-ecar-km-field");
    const ecarKmInput = document.getElementById("pv-ecar-km");
    const consumptionInput = document.getElementById("pv-consumption");
    const kwpInput = document.getElementById("pv-kwp");
    const investmentInput = document.getElementById("pv-investment");
    const batterySizeInput = document.getElementById("pv-battery-size");
    const batteryInvestmentInput = document.getElementById("pv-battery-investment");

    function applyConsumptionSuggestion() {
      if (!consumptionInput || consumptionInput.dataset.touched === "true") return;
      const persons = parseNumberInput(personsInput);
      const hasEcar = !!(ecarCheck && ecarCheck.checked);
      const ecarKm = parseNumberInput(ecarKmInput);
      setSliderValue("pv-consumption", estimatePvConsumption(persons, hasEcar, ecarKm));
    }

    function applyInvestmentSuggestion() {
      if (!investmentInput || investmentInput.dataset.touched === "true") return;
      setSliderValue("pv-investment", estimatePvInvestment(parseNumberInput(kwpInput)));
    }

    function applyBatteryInvestmentSuggestion() {
      if (!batteryInvestmentInput || batteryInvestmentInput.dataset.touched === "true") return;
      setSliderValue("pv-battery-investment", estimatePvBatteryInvestment(parseNumberInput(batterySizeInput)));
    }

    [consumptionInput, investmentInput, batteryInvestmentInput].forEach(function (el) {
      if (el) el.addEventListener("input", function () { el.dataset.touched = "true"; });
    });

    if (personsInput) personsInput.addEventListener("input", applyConsumptionSuggestion);
    if (ecarKmInput) ecarKmInput.addEventListener("input", applyConsumptionSuggestion);
    if (ecarCheck) {
      ecarCheck.addEventListener("change", function () {
        if (ecarKmField) ecarKmField.hidden = !ecarCheck.checked;
        applyConsumptionSuggestion();
        if (!document.getElementById("pv-results").hidden) runPvCalculation();
      });
    }
    if (kwpInput) kwpInput.addEventListener("input", applyInvestmentSuggestion);
    if (batterySizeInput) batterySizeInput.addEventListener("input", applyBatteryInvestmentSuggestion);

    const zipInput = document.getElementById("pv-zip");
    const zipHint = document.getElementById("pv-zip-hint");
    if (zipInput) {
      zipInput.addEventListener("input", function () {
        const estimate = estimatePvYieldFromZip(zipInput.value.trim());
        if (estimate !== null) {
          if (zipHint) {
            zipHint.textContent = "Regionaler Schätzwert für Ihre PLZ übernommen: " + estimate + " kWh/kWp/Jahr.";
            zipHint.hidden = false;
          }
        } else if (zipHint) {
          zipHint.textContent = "Ohne erkannte Postleitzahl wird der bundesweite Durchschnittswert von " + DEFAULT_PV_YIELD + " kWh/kWp/Jahr verwendet.";
          zipHint.hidden = zipInput.value.trim() === "";
        }
        if (!document.getElementById("pv-results").hidden) runPvCalculation();
      });
    }

    document.getElementById("pv-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      if (zipHint) zipHint.hidden = true;
      const yieldDisplayReset = document.getElementById("pv-yield-display");
      if (yieldDisplayReset) yieldDisplayReset.textContent = DEFAULT_PV_YIELD + " kWh/kWp/Jahr (bundesweiter Durchschnitt)";
      [consumptionInput, investmentInput, batteryInvestmentInput].forEach(function (el) {
        if (el) el.dataset.touched = "false";
      });
      if (ecarKmField) ecarKmField.hidden = true;
      applyConsumptionSuggestion();
      applyInvestmentSuggestion();
      applyBatteryInvestmentSuggestion();
      document.getElementById("pv-results").hidden = true;
      document.getElementById("pv-error").hidden = true;
    });

    document.getElementById("pv-print").addEventListener("click", function () {
      if (document.getElementById("pv-results").hidden) {
        showModal("Kein Ergebnis vorhanden", "Bitte berechnen Sie zunächst Ihre PV-Anlage, bevor Sie das Ergebnis drucken.");
        return;
      }
      window.print();
    });
  }

  /* ======================================================================
     ZINSESZINSRECHNER – Berechnungskern (reine Funktion)
     ====================================================================== */

  function calculateCompoundInterest(inp) {
    if (!isFinite(inp.startCapital) || inp.startCapital < 0) {
      return { error: "Das Startkapital darf nicht negativ sein." };
    }
    if (!isFinite(inp.monthlyRate) || inp.monthlyRate < 0) {
      return { error: "Die monatliche Sparrate darf nicht negativ sein." };
    }
    if (!isFinite(inp.annualInterest) || inp.annualInterest < 0) {
      return { error: "Der Zinssatz darf nicht negativ sein." };
    }
    if (!isFinite(inp.years) || inp.years < 1) {
      return { error: "Die Laufzeit muss mindestens 1 Jahr betragen." };
    }

    const n = Math.round(inp.years * 12);
    const i = inp.annualInterest / 100 / 12;

    let finalCapital;
    if (i > 0) {
      const growthFactor = Math.pow(1 + i, n);
      finalCapital = inp.startCapital * growthFactor + inp.monthlyRate * ((growthFactor - 1) / i);
    } else {
      finalCapital = inp.startCapital + inp.monthlyRate * n;
    }

    const totalContributions = inp.startCapital + inp.monthlyRate * n;
    const totalInterest = finalCapital - totalContributions;

    return { finalCapital, totalContributions, totalInterest, months: n };
  }

  function readCompoundInterestForm() {
    return {
      startCapital: parseNumberInput(document.getElementById("z-start")),
      monthlyRate: parseNumberInput(document.getElementById("z-rate")),
      annualInterest: parseNumberInput(document.getElementById("z-interest")),
      years: parseNumberInput(document.getElementById("z-years"))
    };
  }

  function renderCompoundInterestResults(result) {
    const errorEl = document.getElementById("z-error");
    const resultsEl = document.getElementById("z-results");

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      resultsEl.hidden = true;
      return;
    }
    errorEl.hidden = true;

    const grid = document.getElementById("z-result-grid");
    clearChildren(grid);
    grid.appendChild(createResultItem("Endkapital", formatEuro(result.finalCapital), "positive"));
    grid.appendChild(createResultItem("Eingezahltes Kapital", formatEuro(result.totalContributions)));
    grid.appendChild(createResultItem("Zinsertrag", formatEuro(result.totalInterest), result.totalInterest >= 0 ? "positive" : "negative"));

    const maxValue = Math.max(result.totalContributions, result.finalCapital, 1);
    const chart = document.getElementById("z-bar-chart");
    clearChildren(chart);
    [
      ["Eingezahltes Kapital", result.totalContributions, "ice"],
      ["Endkapital (inkl. Zinsertrag)", result.finalCapital, "ev"]
    ].forEach(function (row) {
      const wrap = document.createElement("div");
      wrap.className = "bar-row";
      const labelRow = document.createElement("div");
      labelRow.className = "bar-row-label";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = row[0];
      const valSpan = document.createElement("span");
      valSpan.textContent = formatEuro(row[1]);
      labelRow.appendChild(nameSpan);
      labelRow.appendChild(valSpan);
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill " + row[2];
      fill.style.width = Math.max(0, Math.min(100, (row[1] / maxValue) * 100)) + "%";
      track.appendChild(fill);
      wrap.appendChild(labelRow);
      wrap.appendChild(track);
      chart.appendChild(wrap);
    });

    const wasHidden = resultsEl.hidden;
    resultsEl.hidden = false;
    if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initCompoundInterestCalculator() {
    const form = document.getElementById("z-form");
    if (!form) return;

    function run() {
      const inputs = readCompoundInterestForm();
      const result = calculateCompoundInterest(inputs);
      renderCompoundInterestResults(result);
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) {
      if (e.target && e.target.type === "range" && !document.getElementById("z-results").hidden) run();
    });

    document.getElementById("z-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("z-results").hidden = true;
      document.getElementById("z-error").hidden = true;
    });

    document.getElementById("z-print").addEventListener("click", function () {
      if (document.getElementById("z-results").hidden) {
        showModal("Kein Ergebnis vorhanden", "Bitte berechnen Sie zunächst Ihr Ergebnis, bevor Sie es drucken.");
        return;
      }
      window.print();
    });
  }

  /* ======================================================================
     ENTNAHMEPLANRECHNER – Berechnungskern (reine Funktion)
     Monatliche Simulation: Kapital wächst mit der erwarteten Rendite und wird
     um die (jährlich um die Inflationsrate steigende) Entnahme reduziert.
     ====================================================================== */

  function calculateWithdrawalPlan(inp) {
    if (!isFinite(inp.startCapital) || inp.startCapital <= 0) {
      return { error: "Das Startkapital muss größer als 0 Euro sein." };
    }
    if (!isFinite(inp.annualReturn) || inp.annualReturn < 0) {
      return { error: "Die erwartete Rendite darf nicht negativ sein." };
    }
    if (!isFinite(inp.monthlyWithdrawal) || inp.monthlyWithdrawal <= 0) {
      return { error: "Die monatliche Entnahme muss größer als 0 Euro sein." };
    }
    if (!isFinite(inp.inflationRate) || inp.inflationRate < 0) {
      return { error: "Die Inflationsrate darf nicht negativ sein." };
    }
    if (!isFinite(inp.maxYears) || inp.maxYears < 1) {
      return { error: "Der Betrachtungszeitraum muss mindestens 1 Jahr betragen." };
    }

    const monthlyReturn = inp.annualReturn / 100 / 12;
    const maxMonths = Math.round(inp.maxYears * 12);

    let capital = inp.startCapital;
    let withdrawal = inp.monthlyWithdrawal;
    let totalWithdrawn = 0;
    let depleted = false;
    let months = 0;

    for (let m = 1; m <= maxMonths; m++) {
      capital = capital * (1 + monthlyReturn) - withdrawal;
      totalWithdrawn += withdrawal;
      months = m;
      if (capital <= 0) {
        capital = 0;
        depleted = true;
        break;
      }
      if (m % 12 === 0) {
        withdrawal = withdrawal * (1 + inp.inflationRate / 100);
      }
    }

    const depletionYears = Math.floor(months / 12);
    const depletionMonths = months % 12;
    const sustainableWithdrawal = inp.startCapital * monthlyReturn;

    return {
      depleted, months, depletionYears, depletionMonths,
      remainingCapital: capital, totalWithdrawn, sustainableWithdrawal,
      maxYears: inp.maxYears
    };
  }

  function readWithdrawalPlanForm() {
    return {
      startCapital: parseNumberInput(document.getElementById("ep-capital")),
      annualReturn: parseNumberInput(document.getElementById("ep-return")),
      monthlyWithdrawal: parseNumberInput(document.getElementById("ep-withdrawal")),
      inflationRate: parseNumberInput(document.getElementById("ep-inflation")),
      maxYears: parseNumberInput(document.getElementById("ep-years"))
    };
  }

  function renderWithdrawalPlanResults(result) {
    const errorEl = document.getElementById("ep-error");
    const resultsEl = document.getElementById("ep-results");

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      resultsEl.hidden = true;
      return;
    }
    errorEl.hidden = true;

    const grid = document.getElementById("ep-result-grid");
    clearChildren(grid);

    if (result.depleted) {
      grid.appendChild(createResultItem(
        "Kapital reicht rechnerisch für",
        result.depletionYears + " Jahre" + (result.depletionMonths > 0 ? ", " + result.depletionMonths + " Monate" : ""),
        "negative"
      ));
    } else {
      grid.appendChild(createResultItem(
        "Ergebnis nach " + result.maxYears + " Jahren",
        "Kapital reicht länger als der Betrachtungszeitraum",
        "positive"
      ));
      grid.appendChild(createResultItem("Restkapital nach Betrachtungszeitraum", formatEuro(result.remainingCapital), "positive"));
    }

    grid.appendChild(createResultItem("Insgesamt entnommen (bis Ende der Simulation)", formatEuro(result.totalWithdrawn)));
    grid.appendChild(createResultItem(
      "Nachhaltige Entnahme ohne Kapitalverzehr (heutige Kaufkraft)",
      formatEuro(result.sustainableWithdrawal) + " / Monat"
    ));

    const trafficEl = document.getElementById("ep-traffic");
    let status, statusText;
    if (!result.depleted) {
      status = "green"; statusText = "Unter den eingegebenen Annahmen reicht das Kapital über den gesamten Betrachtungszeitraum.";
    } else if (result.depletionYears >= 20) {
      status = "yellow"; statusText = "Kapital reicht rechnerisch lange, wird aber innerhalb des Betrachtungszeitraums aufgebraucht.";
    } else {
      status = "red"; statusText = "Kapital ist unter diesen Annahmen rechnerisch vergleichsweise schnell aufgebraucht.";
    }
    setTrafficLight(trafficEl, document.getElementById("ep-traffic-dot"), document.getElementById("ep-traffic-text"), status, statusText);

    const wasHidden = resultsEl.hidden;
    resultsEl.hidden = false;
    if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initWithdrawalPlanCalculator() {
    const form = document.getElementById("ep-form");
    if (!form) return;

    function run() {
      const inputs = readWithdrawalPlanForm();
      const result = calculateWithdrawalPlan(inputs);
      renderWithdrawalPlanResults(result);
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) {
      if (e.target && e.target.type === "range" && !document.getElementById("ep-results").hidden) run();
    });

    document.getElementById("ep-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("ep-results").hidden = true;
      document.getElementById("ep-error").hidden = true;
    });

    document.getElementById("ep-print").addEventListener("click", function () {
      if (document.getElementById("ep-results").hidden) {
        showModal("Kein Ergebnis vorhanden", "Bitte berechnen Sie zunächst Ihren Entnahmeplan, bevor Sie ihn drucken.");
        return;
      }
      window.print();
    });
  }

  /* ======================================================================
     WÄRMEPUMPEN-VORPRÜFUNG – Berechnungskern (reine Funktion)
     Grobe Schätzung der Jahresarbeitszahl (JAZ) anhand Dämmstandard und
     Wärmeverteilung, daraus abgeleiteter Stromverbrauch und Kostenvergleich.
     ====================================================================== */

  const WP_BASE_JAZ = { unsaniert: 2.6, teilsaniert: 3.2, saniert: 3.8, neubau: 4.3 };
  const WP_EMITTER_ADJUST = { fussboden: 0.4, niedertemperatur: 0, hochtemperatur: -0.6 };

  function calculateHeatPump(inp) {
    if (!isFinite(inp.area) || inp.area <= 0) return { error: "Die Wohnfläche muss größer als 0 m² sein." };
    if (!isFinite(inp.heatDemand) || inp.heatDemand <= 0) return { error: "Der jährliche Heizenergiebedarf muss größer als 0 kWh sein." };
    if (!isFinite(inp.heatingCost) || inp.heatingCost < 0) return { error: "Die aktuellen Heizkosten dürfen nicht negativ sein." };
    if (!isFinite(inp.price) || inp.price < 0) return { error: "Der Strompreis darf nicht negativ sein." };
    if (!WP_BASE_JAZ.hasOwnProperty(inp.insulation)) return { error: "Bitte wählen Sie einen Dämmstandard aus." };
    if (!WP_EMITTER_ADJUST.hasOwnProperty(inp.emitter)) return { error: "Bitte wählen Sie eine Wärmeverteilung aus." };

    let jaz = WP_BASE_JAZ[inp.insulation] + WP_EMITTER_ADJUST[inp.emitter];
    jaz = Math.max(1.8, Math.min(5.0, jaz));

    const wpElectricityDemand = inp.heatDemand / jaz;
    const wpAnnualCost = wpElectricityDemand * inp.price;
    const savings = inp.heatingCost - wpAnnualCost;

    let status, statusText;
    if (jaz >= 3.5) {
      status = "green"; statusText = "Unter den eingegebenen Annahmen grundsätzlich gut für eine Wärmepumpe geeignet.";
    } else if (jaz >= 2.8) {
      status = "yellow"; statusText = "Geeignet mit Einschränkungen – bauliche Verbesserungen könnten die Effizienz deutlich erhöhen.";
    } else {
      status = "red"; statusText = "Ohne bauliche Verbesserungen (Dämmung, größere Heizkörper) rechnerisch eher ungeeignet.";
    }

    return { jaz, wpElectricityDemand, wpAnnualCost, savings, status, statusText };
  }

  const HEATING_TYPE_LABELS = {
    gas: "Gasheizung", oel: "Ölheizung", fernwaerme: "Fernwärme",
    nachtspeicher: "Strom-Nachtspeicher", sonstige: "aktuelle Heizung"
  };

  function initHeatPumpCalculator() {
    const form = document.getElementById("wp-form");
    if (!form) return;

    const frequencySelect = document.getElementById("wp-frequency");

    function updateFrequencyVisibility() {
      if (!frequencySelect) return;
      const yearField = document.getElementById("wp-heatingcost-year-field");
      const monthField = document.getElementById("wp-heatingcost-month-field");
      const isMonthly = frequencySelect.value === "monat";
      if (yearField) yearField.hidden = isMonthly;
      if (monthField) monthField.hidden = !isMonthly;
    }

    function syncFrequencyValues(fromFrequency) {
      const yearInput = document.getElementById("wp-heatingcost");
      const monthInput = document.getElementById("wp-heatingcost-month");
      if (!yearInput || !monthInput) return;
      if (fromFrequency === "monat") {
        setSliderValue("wp-heatingcost", Math.round(parseNumberInput(monthInput) * 12));
      } else {
        setSliderValue("wp-heatingcost-month", Math.round(parseNumberInput(yearInput) / 12));
      }
    }

    function readHeatingCost() {
      if (frequencySelect && frequencySelect.value === "monat") {
        return parseNumberInput(document.getElementById("wp-heatingcost-month")) * 12;
      }
      return parseNumberInput(document.getElementById("wp-heatingcost"));
    }

    function run() {
      const result = calculateHeatPump({
        area: parseNumberInput(document.getElementById("wp-area")),
        heatDemand: parseNumberInput(document.getElementById("wp-heatdemand")),
        heatingCost: readHeatingCost(),
        price: parseNumberInput(document.getElementById("wp-price")),
        insulation: document.getElementById("wp-insulation").value,
        emitter: document.getElementById("wp-emitter").value
      });

      const errorEl = document.getElementById("wp-error");
      const resultsEl = document.getElementById("wp-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const heatingTypeEl = document.getElementById("wp-heatingtype");
      const heatingLabel = HEATING_TYPE_LABELS[heatingTypeEl ? heatingTypeEl.value : ""] || "aktuelle Heizung";

      const grid = document.getElementById("wp-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Geschätzte Jahresarbeitszahl (JAZ)", formatNumber(result.jaz, 2)));
      grid.appendChild(createResultItem("Geschätzter Stromverbrauch Wärmepumpe", formatNumber(result.wpElectricityDemand, 0) + " kWh/Jahr"));
      grid.appendChild(createResultItem("Geschätzte Stromkosten Wärmepumpe", formatEuro(result.wpAnnualCost) + " / Jahr"));
      grid.appendChild(createResultItem(
        "Ersparnis ggü. " + heatingLabel,
        formatEuro(result.savings) + " / Jahr",
        result.savings >= 0 ? "positive" : "negative"
      ));
      grid.appendChild(createResultItem(
        "Ersparnis pro Monat",
        formatEuro(result.savings / 12),
        result.savings >= 0 ? "positive" : "negative"
      ));

      const trafficEl = document.getElementById("wp-traffic");
      setTrafficLight(trafficEl, document.getElementById("wp-traffic-dot"), document.getElementById("wp-traffic-text"), result.status, result.statusText);

      const summaryEl = document.getElementById("wp-summary");
      if (summaryEl) {
        summaryEl.textContent = "Kurz zusammengefasst: Mit einer geschätzten JAZ von " + formatNumber(result.jaz, 1) +
          " läge Ihre Wärmepumpe bei rund " + formatEuro(result.wpAnnualCost) + " Stromkosten pro Jahr – " +
          (result.savings >= 0
            ? "das wären ca. " + formatEuro(result.savings) + " weniger pro Jahr als aktuell (" + heatingLabel + ")."
            : "das wären ca. " + formatEuro(Math.abs(result.savings)) + " mehr pro Jahr als aktuell (" + heatingLabel + ").");
      }

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && (e.target.type === "range" || e.target.tagName === "SELECT") && !document.getElementById("wp-results").hidden) run(); });
    form.addEventListener("change", function (e) { if (e.target.tagName === "SELECT") run(); });

    if (frequencySelect) {
      frequencySelect.addEventListener("change", function () {
        syncFrequencyValues(frequencySelect.value === "monat" ? "jahr" : "monat");
        updateFrequencyVisibility();
        run();
      });
    }

    document.getElementById("wp-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      updateFrequencyVisibility();
      document.getElementById("wp-results").hidden = true;
      document.getElementById("wp-error").hidden = true;
    });

    updateFrequencyVisibility();
    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("wp-results").hidden = false;
    run();
  }

  /* ======================================================================
     SANIERUNGSKOSTENRECHNER
     ====================================================================== */

  function calculateRenovation(inp) {
    if (!isFinite(inp.area) || inp.area <= 0) return { error: "Die Wohnfläche muss größer als 0 m² sein." };
    if (!inp.roof && !inp.facade && !inp.windows && !inp.heating) {
      return { error: "Bitte wählen Sie mindestens eine Maßnahme aus." };
    }
    if (!isFinite(inp.subsidyPercent) || inp.subsidyPercent < 0 || inp.subsidyPercent > 70) {
      return { error: "Die Förderquote muss zwischen 0 % und 70 % liegen." };
    }
    const items = [];
    let total = 0;
    if (inp.roof) { const c = inp.area * 80; items.push({ label: "Dach / Dachdämmung", cost: c }); total += c; }
    if (inp.facade) { const c = inp.area * 130; items.push({ label: "Fassadendämmung", cost: c }); total += c; }
    if (inp.windows) { const c = inp.area * 60; items.push({ label: "Fenstertausch", cost: c }); total += c; }
    if (inp.heating) { const c = 18000 + inp.area * 40; items.push({ label: "Heizungstausch (z. B. Wärmepumpe)", cost: c }); total += c; }
    const subsidyAmount = total * (inp.subsidyPercent / 100);
    const netCost = total - subsidyAmount;
    return { items, total, subsidyAmount, netCost };
  }

  function initRenovationCalculator() {
    const form = document.getElementById("sr-form");
    if (!form) return;

    function run() {
      const result = calculateRenovation({
        area: parseNumberInput(document.getElementById("sr-area")),
        roof: document.getElementById("sr-roof").checked,
        facade: document.getElementById("sr-facade").checked,
        windows: document.getElementById("sr-windows").checked,
        heating: document.getElementById("sr-heating").checked,
        subsidyPercent: parseNumberInput(document.getElementById("sr-subsidy"))
      });

      const errorEl = document.getElementById("sr-error");
      const resultsEl = document.getElementById("sr-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("sr-result-grid");
      clearChildren(grid);
      result.items.forEach(function (item) {
        grid.appendChild(createResultItem(item.label, formatEuro(item.cost)));
      });
      grid.appendChild(createResultItem("Geschätzte Gesamtkosten", formatEuro(result.total)));
      grid.appendChild(createResultItem("Geschätzte Förderung", "− " + formatEuro(result.subsidyAmount), "positive"));
      grid.appendChild(createResultItem("Voraussichtliche Eigenkosten", formatEuro(result.netCost)));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) {
      if (e.target && (e.target.type === "range" || e.target.type === "checkbox") && !document.getElementById("sr-results").hidden) run();
    });

    document.getElementById("sr-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("sr-results").hidden = true;
      document.getElementById("sr-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("sr-results").hidden = false;
    run();
  }

  /* ======================================================================
     MIETRENDITERECHNER
     ====================================================================== */

  function calculateRentalYield(inp) {
    if (!isFinite(inp.price) || inp.price <= 0) return { error: "Der Kaufpreis muss größer als 0 € sein." };
    if (!isFinite(inp.annualRent) || inp.annualRent < 0) return { error: "Die Jahreskaltmiete darf nicht negativ sein." };
    if (!isFinite(inp.equity) || inp.equity < 0) return { error: "Das Eigenkapital darf nicht negativ sein." };

    const totalCost = inp.price * (1 + inp.buyingCostsPercent / 100);
    const grossYield = (inp.annualRent / totalCost) * 100;
    const operatingCosts = inp.annualRent * (inp.operatingCostsPercent / 100);
    const netAnnualRent = inp.annualRent - operatingCosts;
    const netYield = (netAnnualRent / totalCost) * 100;

    const loanAmount = Math.max(0, totalCost - inp.equity);
    const annualInterest = loanAmount * (inp.interestRate / 100);
    const cashFlowBeforeTax = netAnnualRent - annualInterest;
    const equityYield = inp.equity > 0 ? (cashFlowBeforeTax / inp.equity) * 100 : null;

    let status, statusText;
    if (netYield >= 5) { status = "green"; statusText = "Nettomietrendite liegt in einem attraktiven Bereich."; }
    else if (netYield >= 3) { status = "yellow"; statusText = "Nettomietrendite liegt im mittleren, marktüblichen Bereich."; }
    else { status = "red"; statusText = "Nettomietrendite liegt eher niedrig – Kaufpreis oder Miete genau prüfen."; }

    return { totalCost, grossYield, netAnnualRent, netYield, loanAmount, annualInterest, cashFlowBeforeTax, equityYield, status, statusText };
  }

  function initRentalYieldCalculator() {
    const form = document.getElementById("mr-form");
    if (!form) return;

    function run() {
      const result = calculateRentalYield({
        price: parseNumberInput(document.getElementById("mr-price")),
        buyingCostsPercent: parseNumberInput(document.getElementById("mr-buyingcosts")),
        annualRent: parseNumberInput(document.getElementById("mr-rent")),
        operatingCostsPercent: parseNumberInput(document.getElementById("mr-opcosts")),
        equity: parseNumberInput(document.getElementById("mr-equity")),
        interestRate: parseNumberInput(document.getElementById("mr-interest"))
      });

      const errorEl = document.getElementById("mr-error");
      const resultsEl = document.getElementById("mr-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("mr-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Kaufpreis inkl. Nebenkosten", formatEuro(result.totalCost)));
      grid.appendChild(createResultItem("Bruttomietrendite", formatPercent(result.grossYield, 2)));
      grid.appendChild(createResultItem("Nettomietrendite", formatPercent(result.netYield, 2)));
      grid.appendChild(createResultItem("Darlehensbetrag", formatEuro(result.loanAmount)));
      grid.appendChild(createResultItem("Zinskosten pro Jahr", formatEuro(result.annualInterest)));
      grid.appendChild(createResultItem(
        "Cashflow vor Steuern pro Jahr",
        formatEuro(result.cashFlowBeforeTax),
        result.cashFlowBeforeTax >= 0 ? "positive" : "negative"
      ));
      if (result.equityYield !== null) {
        grid.appendChild(createResultItem("Eigenkapitalrendite (Jahr 1)", formatPercent(result.equityYield, 2)));
      }

      const trafficEl = document.getElementById("mr-traffic");
      setTrafficLight(trafficEl, document.getElementById("mr-traffic-dot"), document.getElementById("mr-traffic-text"), result.status, result.statusText);

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("mr-results").hidden) run(); });

    document.getElementById("mr-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("mr-results").hidden = true;
      document.getElementById("mr-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("mr-results").hidden = false;
    run();
  }

  /* ======================================================================
     MIETEN-ODER-KAUFEN-RECHNER
     ====================================================================== */

  function calculateRentVsBuy(inp) {
    if (!isFinite(inp.price) || inp.price <= 0) return { error: "Der Kaufpreis muss größer als 0 € sein." };
    if (!isFinite(inp.equity) || inp.equity < 0) return { error: "Das Eigenkapital darf nicht negativ sein." };
    if (!isFinite(inp.comparableRent) || inp.comparableRent < 0) return { error: "Die Vergleichsmiete darf nicht negativ sein." };
    if (!isFinite(inp.years) || inp.years <= 0) return { error: "Der Betrachtungszeitraum muss größer als 0 Jahre sein." };

    const totalCost = inp.price * (1 + inp.buyingCostsPercent / 100);
    const loanAmount = Math.max(0, totalCost - inp.equity);
    const monthlyRate = inp.interestRate / 100 / 12;
    const monthlyPayment = loanAmount * ((inp.interestRate + inp.repaymentPercent) / 100 / 12);
    const monthlyOpportunityRate = inp.opportunityRate / 100 / 12;
    const months = Math.round(inp.years * 12);

    let remainingDebt = loanAmount;
    let renterCapital = inp.equity;
    let currentRent = inp.comparableRent;

    for (let m = 1; m <= months; m++) {
      let payment = 0;
      if (remainingDebt > 0.01) {
        const interest = remainingDebt * monthlyRate;
        let principal = monthlyPayment - interest;
        if (principal < 0) principal = 0;
        if (principal > remainingDebt) principal = remainingDebt;
        remainingDebt -= principal;
        payment = interest + principal;
      }
      const buyMonthlyCost = payment + inp.maintenanceReserve;
      const diff = buyMonthlyCost - currentRent;
      renterCapital = renterCapital * (1 + monthlyOpportunityRate) + diff;
      if (m % 12 === 0) currentRent *= (1 + inp.rentIncrease / 100);
    }

    const propertyValueEnd = inp.price * Math.pow(1 + inp.appreciationRate / 100, inp.years);
    const buyerWealth = propertyValueEnd - remainingDebt;
    const renterWealth = renterCapital;
    const advantage = buyerWealth - renterWealth;

    let status, statusText;
    const threshold = inp.price * 0.1;
    if (advantage > threshold) { status = "green"; statusText = "In diesem Modell steht der Kauf am Ende vermögensmäßig besser da."; }
    else if (advantage > -threshold) { status = "yellow"; statusText = "Kaufen und Mieten liegen in diesem Modell nahe beieinander."; }
    else { status = "red"; statusText = "In diesem Modell steht das Mieten mit angelegtem Kapital am Ende besser da."; }

    return { totalCost, loanAmount, monthlyPayment, propertyValueEnd, remainingDebtEnd: remainingDebt, buyerWealth, renterWealth, advantage, status, statusText };
  }

  function initRentVsBuyCalculator() {
    const form = document.getElementById("mk-form");
    if (!form) return;

    function run() {
      const result = calculateRentVsBuy({
        price: parseNumberInput(document.getElementById("mk-price")),
        buyingCostsPercent: parseNumberInput(document.getElementById("mk-buyingcosts")),
        equity: parseNumberInput(document.getElementById("mk-equity")),
        interestRate: parseNumberInput(document.getElementById("mk-interest")),
        repaymentPercent: parseNumberInput(document.getElementById("mk-repayment")),
        maintenanceReserve: parseNumberInput(document.getElementById("mk-maintenance")),
        comparableRent: parseNumberInput(document.getElementById("mk-rent")),
        rentIncrease: parseNumberInput(document.getElementById("mk-rentincrease")),
        appreciationRate: parseNumberInput(document.getElementById("mk-appreciation")),
        opportunityRate: parseNumberInput(document.getElementById("mk-opportunity")),
        years: parseNumberInput(document.getElementById("mk-years"))
      });

      const errorEl = document.getElementById("mk-error");
      const resultsEl = document.getElementById("mk-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("mk-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Monatliche Kreditrate (Kauf)", formatEuro(result.monthlyPayment)));
      grid.appendChild(createResultItem("Immobilienwert am Ende", formatEuro(result.propertyValueEnd)));
      grid.appendChild(createResultItem("Restschuld am Ende", formatEuro(result.remainingDebtEnd)));
      grid.appendChild(createResultItem("Vermögen bei Kauf am Ende", formatEuro(result.buyerWealth)));
      grid.appendChild(createResultItem("Vermögen bei Miete + Anlage am Ende", formatEuro(result.renterWealth)));
      grid.appendChild(createResultItem(
        "Vorteil Kaufen gegenüber Mieten",
        formatEuro(result.advantage),
        result.advantage >= 0 ? "positive" : "negative"
      ));

      const trafficEl = document.getElementById("mk-traffic");
      setTrafficLight(trafficEl, document.getElementById("mk-traffic-dot"), document.getElementById("mk-traffic-text"), result.status, result.statusText);

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("mk-results").hidden) run(); });

    document.getElementById("mk-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("mk-results").hidden = true;
      document.getElementById("mk-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("mk-results").hidden = false;
    run();
  }

  /* ======================================================================
     HAUSKOSTENRECHNER
     ====================================================================== */

  /* Grobe regionale Näherung für die Grundsteuer anhand der ersten PLZ-Ziffer.
     Grundlage: bundesweiter Durchschnitt für ein Einfamilienhaus von rund
     478 Euro/Jahr bei ca. 120 m² Wohnfläche (~4 Euro/m²/Jahr), mit regionalen
     Faktoren nach den am Markt kursierenden Bundesländer-Vergleichswerten
     (u. a. NRW/Sachsen spürbar über, Bayern/Baden-Württemberg/Hessen meist
     unter dem Durchschnitt). Grundsteuer-Hebesätze werden von jeder Gemeinde
     einzeln festgelegt und schwanken auch innerhalb einer Region stark -
     dies ist daher nur ein grober Ausgangspunkt, kein Bescheid-Ersatz. */
  const PROPERTY_TAX_PER_SQM_BASE = 4.0;
  const PROPERTY_TAX_REGION_FACTOR = {
    "0": 1.15, "1": 1.05, "2": 1.0, "3": 1.0, "4": 1.3,
    "5": 1.1, "6": 0.9, "7": 0.85, "8": 0.85, "9": 0.85
  };

  function estimatePropertyTax(area, zip) {
    if (!isFinite(area) || area <= 0) return 0;
    let factor = 1.0;
    if (/^\d{5}$/.test(zip || "")) {
      const prefix = String(zip).charAt(0);
      if (PROPERTY_TAX_REGION_FACTOR[prefix] !== undefined) factor = PROPERTY_TAX_REGION_FACTOR[prefix];
    }
    return Math.round((PROPERTY_TAX_PER_SQM_BASE * factor * area) / 10) * 10;
  }

  /* Reine Auto-Vorschlagsfunktionen (kein I/O) für die laufenden Kosten
     anhand der Haushaltsgröße bzw. Wohnfläche - greifen auf dieselben
     Bundesdurchschnittswerte zurück wie der Strom-&-Gas-Sparrechner
     (ENERGY_BENCHMARKS) und die Versicherungs-Kostenorientierung
     (INSURANCE_BENCHMARKS), damit die Zahlen im ganzen Rechner konsistent
     bleiben. */
  function estimateHeatingCost(persons) {
    const p = Math.max(1, Math.min(7, Math.round(isFinite(persons) ? persons : 2)));
    const kwh = ENERGY_BENCHMARKS.gas.consumptionByPersons[p] || ENERGY_BENCHMARKS.gas.consumptionByPersons[2];
    return Math.round((kwh * ENERGY_BENCHMARKS.gas.currentPricePerKwh) / 50) * 50;
  }

  function estimateElectricityCost(persons) {
    const p = Math.max(1, Math.min(7, Math.round(isFinite(persons) ? persons : 2)));
    const kwh = ENERGY_BENCHMARKS.strom.consumptionByPersons[p] || ENERGY_BENCHMARKS.strom.consumptionByPersons[2];
    return Math.round((kwh * ENERGY_BENCHMARKS.strom.currentPricePerKwh) / 50) * 50;
  }

  function estimateWaterCost(persons) {
    const p = Math.max(1, Math.min(7, isFinite(persons) ? persons : 2));
    return Math.round((p * 180) / 10) * 10;
  }

  function estimateWasteCost(persons) {
    const p = Math.max(1, Math.min(7, isFinite(persons) ? persons : 2));
    return Math.round((80 + p * 40) / 10) * 10;
  }

  function estimateBuildingInsurance(area) {
    if (!isFinite(area) || area <= 0) return 0;
    const bench = INSURANCE_BENCHMARKS.wohngebaeude;
    const midPerQm = (bench.lowPerQm + bench.highPerQm) / 2;
    return Math.round((midPerQm * area) / 10) * 10;
  }

  function calculateHouseCosts(inp) {
    if (!isFinite(inp.area) || inp.area <= 0) return { error: "Die Wohnfläche muss größer als 0 m² sein." };
    const items = [
      { label: "Grundsteuer", value: inp.propertyTax },
      { label: "Gebäudeversicherung", value: inp.buildingInsurance },
      { label: "Heizkosten", value: inp.heating },
      { label: "Stromkosten", value: inp.electricity },
      { label: "Wasser / Abwasser", value: inp.water },
      { label: "Müllabfuhr / Straßenreinigung", value: inp.waste },
      { label: "Instandhaltungsrücklage", value: inp.maintenance },
      { label: "Sonstiges", value: inp.other }
    ];
    for (const item of items) {
      if (!isFinite(item.value) || item.value < 0) return { error: "Bitte geben Sie bei allen Kostenpositionen einen Wert ≥ 0 an." };
    }
    const total = items.reduce(function (sum, item) { return sum + item.value; }, 0);
    const perMonth = total / 12;
    const perSqmMonth = perMonth / inp.area;
    return { items, total, perMonth, perSqmMonth };
  }

  function initHouseCostsCalculator() {
    const form = document.getElementById("hk-form");
    if (!form) return;

    const zipInput = document.getElementById("hk-zip");
    const areaInput = document.getElementById("hk-area");
    const personsInput = document.getElementById("hk-persons");

    // Automatische Vorschläge: nur Felder aktualisieren, die der Nutzer noch
    // nicht selbst angefasst hat (data-touched="false"), analog zum Muster
    // bei den Lebensmittelkosten im Machbarkeitsrechner.
    function applyAutoSuggestions() {
      const area = parseNumberInput(areaInput);
      const zip = (zipInput && zipInput.value || "").trim();
      const persons = parseNumberInput(personsInput);

      const propertyTaxInput = document.getElementById("hk-propertytax");
      if (propertyTaxInput && propertyTaxInput.dataset.touched !== "true") {
        setSliderValue("hk-propertytax", estimatePropertyTax(area, zip));
      }
      const insuranceInput = document.getElementById("hk-insurance");
      if (insuranceInput && insuranceInput.dataset.touched !== "true") {
        setSliderValue("hk-insurance", estimateBuildingInsurance(area));
      }
      const heatingInput = document.getElementById("hk-heating");
      if (heatingInput && heatingInput.dataset.touched !== "true") {
        setSliderValue("hk-heating", estimateHeatingCost(persons));
      }
      const electricityInput = document.getElementById("hk-electricity");
      if (electricityInput && electricityInput.dataset.touched !== "true") {
        setSliderValue("hk-electricity", estimateElectricityCost(persons));
      }
      const waterInput = document.getElementById("hk-water");
      if (waterInput && waterInput.dataset.touched !== "true") {
        setSliderValue("hk-water", estimateWaterCost(persons));
      }
      const wasteInput = document.getElementById("hk-waste");
      if (wasteInput && wasteInput.dataset.touched !== "true") {
        setSliderValue("hk-waste", estimateWasteCost(persons));
      }
    }

    ["hk-propertytax", "hk-insurance", "hk-heating", "hk-electricity", "hk-water", "hk-waste"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", function () { el.dataset.touched = "true"; });
    });

    if (areaInput) areaInput.addEventListener("input", function () { applyAutoSuggestions(); });
    if (personsInput) personsInput.addEventListener("input", function () { applyAutoSuggestions(); });
    if (zipInput) {
      zipInput.addEventListener("input", function () {
        const hint = document.getElementById("hk-zip-hint");
        if (hint) {
          hint.textContent = /^\d{5}$/.test(zipInput.value.trim())
            ? "Regionaler Schätzwert für Ihre PLZ bei der Grundsteuer berücksichtigt."
            : "Wird für eine grobe regionale Schätzung der Grundsteuer genutzt. Ohne Postleitzahl wird der bundesweite Durchschnitt verwendet.";
        }
        applyAutoSuggestions();
        if (!document.getElementById("hk-results").hidden) run();
      });
    }

    function run() {
      const result = calculateHouseCosts({
        area: parseNumberInput(document.getElementById("hk-area")),
        propertyTax: parseNumberInput(document.getElementById("hk-propertytax")),
        buildingInsurance: parseNumberInput(document.getElementById("hk-insurance")),
        heating: parseNumberInput(document.getElementById("hk-heating")),
        electricity: parseNumberInput(document.getElementById("hk-electricity")),
        water: parseNumberInput(document.getElementById("hk-water")),
        waste: parseNumberInput(document.getElementById("hk-waste")),
        maintenance: parseNumberInput(document.getElementById("hk-maintenance")),
        other: parseNumberInput(document.getElementById("hk-other"))
      });

      const errorEl = document.getElementById("hk-error");
      const resultsEl = document.getElementById("hk-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("hk-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Gesamtkosten pro Jahr", formatEuro(result.total)));
      grid.appendChild(createResultItem("Gesamtkosten pro Monat", formatEuro(result.perMonth)));
      grid.appendChild(createResultItem("Kosten pro m² und Monat", formatEuro(result.perSqmMonth)));

      const chart = document.getElementById("hk-chart");
      clearChildren(chart);
      const maxVal = Math.max.apply(null, result.items.map(function (i) { return i.value; }).concat([1]));
      result.items.forEach(function (item) {
        if (item.value <= 0) return;
        const row = document.createElement("div");
        row.className = "bar-row";

        const labelRow = document.createElement("div");
        labelRow.className = "bar-row-label";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = item.label;
        const valSpan = document.createElement("span");
        valSpan.textContent = formatEuro(item.value) + " / Jahr";
        labelRow.appendChild(nameSpan);
        labelRow.appendChild(valSpan);

        const track = document.createElement("div");
        track.className = "bar-track";
        const fill = document.createElement("div");
        fill.className = "bar-fill ev";
        fill.style.width = Math.max(2, (item.value / maxVal) * 100) + "%";
        track.appendChild(fill);

        row.appendChild(labelRow);
        row.appendChild(track);
        chart.appendChild(row);
      });

      saveStammdaten({ housingCost: Math.round(result.perMonth) });
      const hkStammHint = document.getElementById("hk-stammdaten-hint");
      if (hkStammHint) hkStammHint.hidden = false;

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("hk-results").hidden) run(); });

    document.getElementById("hk-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("hk-results").hidden = true;
      document.getElementById("hk-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("hk-results").hidden = false;
    run();
  }

  /* ======================================================================
     VERSICHERUNGS-KOSTENORIENTIERUNG
     ====================================================================== */

  const INSURANCE_BENCHMARKS = {
    haftpflicht: { label: "Privathaftpflichtversicherung", basis: "flat", low: 40, high: 90 },
    hausrat: { label: "Hausratversicherung", basis: "qm", lowPerQm: 0.9, highPerQm: 1.6 },
    wohngebaeude: { label: "Wohngebäudeversicherung", basis: "qm", lowPerQm: 3.5, highPerQm: 6.5 },
    rechtsschutz: { label: "Rechtsschutzversicherung", basis: "flat", low: 150, high: 320 }
  };

  function calculateInsuranceCheck(inp) {
    const bench = INSURANCE_BENCHMARKS[inp.type];
    if (!bench) return { error: "Bitte wählen Sie eine Versicherungsart aus." };
    if (!isFinite(inp.currentAmount) || inp.currentAmount < 0) return { error: "Bitte geben Sie einen gültigen Beitrag an." };
    let low, high;
    if (bench.basis === "qm") {
      if (!isFinite(inp.area) || inp.area <= 0) return { error: "Bitte geben Sie eine gültige Wohnfläche an." };
      low = bench.lowPerQm * inp.area;
      high = bench.highPerQm * inp.area;
    } else {
      low = bench.low;
      high = bench.high;
    }
    let status, statusText;
    const possibleAnnualSavings = inp.currentAmount > high ? inp.currentAmount - high : 0;
    if (inp.currentAmount > high) { status = "red"; statusText = "Ihr Beitrag liegt spürbar über dem üblichen Vergleichsrahmen – ein Tarifvergleich könnte sich lohnen."; }
    else if (inp.currentAmount < low) { status = "yellow"; statusText = "Ihr Beitrag liegt unter dem üblichen Rahmen – prüfen Sie, ob der Leistungsumfang ausreicht."; }
    else { status = "green"; statusText = "Ihr Beitrag liegt im üblichen Vergleichsrahmen."; }
    return { label: bench.label, low, high, status, statusText, possibleAnnualSavings, possibleMonthlySavings: possibleAnnualSavings / 12 };
  }

  function initInsuranceCheckCalculator() {
    const form = document.getElementById("vk-form");
    if (!form) return;

    const frequencySelect = document.getElementById("vk-frequency");

    function updateAreaVisibility() {
      const type = document.getElementById("vk-type").value;
      const areaField = document.getElementById("vk-area-field");
      if (areaField) areaField.hidden = !(INSURANCE_BENCHMARKS[type] && INSURANCE_BENCHMARKS[type].basis === "qm");
    }

    function updateFrequencyVisibility() {
      if (!frequencySelect) return;
      const yearField = document.getElementById("vk-amount-year-field");
      const monthField = document.getElementById("vk-amount-month-field");
      const isMonthly = frequencySelect.value === "monat";
      if (yearField) yearField.hidden = isMonthly;
      if (monthField) monthField.hidden = !isMonthly;
    }

    // Beim Umschalten der Zahlweise den jeweils anderen Regler sinnvoll nachziehen,
    // damit keine widersprüchlichen Werte stehen bleiben.
    function syncFrequencyValues(fromFrequency) {
      const yearInput = document.getElementById("vk-amount");
      const monthInput = document.getElementById("vk-amount-month");
      if (!yearInput || !monthInput) return;
      if (fromFrequency === "monat") {
        setSliderValue("vk-amount", Math.round(parseNumberInput(monthInput) * 12));
      } else {
        setSliderValue("vk-amount-month", Math.round(parseNumberInput(yearInput) / 12));
      }
    }

    function readCurrentAmount() {
      if (frequencySelect && frequencySelect.value === "monat") {
        return parseNumberInput(document.getElementById("vk-amount-month")) * 12;
      }
      return parseNumberInput(document.getElementById("vk-amount"));
    }

    function run() {
      updateAreaVisibility();
      const result = calculateInsuranceCheck({
        type: document.getElementById("vk-type").value,
        area: parseNumberInput(document.getElementById("vk-area")),
        currentAmount: readCurrentAmount()
      });

      const errorEl = document.getElementById("vk-error");
      const resultsEl = document.getElementById("vk-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("vk-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Üblicher Vergleichsrahmen von", formatEuro(result.low) + " / Jahr"));
      grid.appendChild(createResultItem("bis", formatEuro(result.high) + " / Jahr"));
      if (result.possibleAnnualSavings > 0) {
        grid.appendChild(createResultItem("Mögliche Einsparung pro Monat", formatEuro(result.possibleMonthlySavings), "positive"));
        grid.appendChild(createResultItem("Mögliche Einsparung pro Jahr", formatEuro(result.possibleAnnualSavings), "positive"));
      }

      const trafficEl = document.getElementById("vk-traffic");
      setTrafficLight(trafficEl, document.getElementById("vk-traffic-dot"), document.getElementById("vk-traffic-text"), result.status, result.statusText);

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("vk-results").hidden) run(); });
    form.addEventListener("change", function (e) { if (e.target.tagName === "SELECT") run(); });

    if (frequencySelect) {
      frequencySelect.addEventListener("change", function () {
        syncFrequencyValues(frequencySelect.value === "monat" ? "jahr" : "monat");
        updateFrequencyVisibility();
        run();
      });
    }

    document.getElementById("vk-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      updateFrequencyVisibility();
      document.getElementById("vk-results").hidden = true;
      document.getElementById("vk-error").hidden = true;
    });

    updateAreaVisibility();
    updateFrequencyVisibility();
    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("vk-results").hidden = false;
    run();
  }

  /* ======================================================================
     SPARPLANRECHNER
     ====================================================================== */

  function calculateSavingsPlan(inp) {
    if (!isFinite(inp.monthlyRate) || inp.monthlyRate < 0) return { error: "Die monatliche Sparrate darf nicht negativ sein." };
    if (!isFinite(inp.startCapital) || inp.startCapital < 0) return { error: "Das Startkapital darf nicht negativ sein." };
    if (!isFinite(inp.years) || inp.years <= 0) return { error: "Die Laufzeit muss größer als 0 Jahre sein." };

    const monthlyReturn = inp.annualReturn / 100 / 12;
    const months = Math.round(inp.years * 12);
    let capital = inp.startCapital;
    let contributions = inp.startCapital;
    let rate = inp.monthlyRate;

    for (let m = 1; m <= months; m++) {
      capital *= (1 + monthlyReturn);
      capital += rate;
      contributions += rate;
      if (m % 12 === 0 && inp.dynamicPercent) rate *= (1 + inp.dynamicPercent / 100);
    }

    const totalGrowth = capital - contributions;
    return { endCapital: capital, totalContributions: contributions, totalGrowth };
  }

  function initSavingsPlanCalculator() {
    const form = document.getElementById("sp-form");
    if (!form) return;

    function run() {
      const result = calculateSavingsPlan({
        monthlyRate: parseNumberInput(document.getElementById("sp-rate")),
        startCapital: parseNumberInput(document.getElementById("sp-start")),
        years: parseNumberInput(document.getElementById("sp-years")),
        annualReturn: parseNumberInput(document.getElementById("sp-return")),
        dynamicPercent: parseNumberInput(document.getElementById("sp-dynamic"))
      });

      const errorEl = document.getElementById("sp-error");
      const resultsEl = document.getElementById("sp-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("sp-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Endkapital", formatEuro(result.endCapital)));
      grid.appendChild(createResultItem("Eingezahlte Beiträge", formatEuro(result.totalContributions)));
      grid.appendChild(createResultItem("Wertzuwachs", formatEuro(result.totalGrowth), "positive"));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("sp-results").hidden) run(); });

    document.getElementById("sp-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("sp-results").hidden = true;
      document.getElementById("sp-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("sp-results").hidden = false;
    run();
  }

  /* ======================================================================
     RENTENLÜCKENRECHNER
     ====================================================================== */

  function calculatePensionGap(inp) {
    if (!isFinite(inp.netIncome) || inp.netIncome <= 0) return { error: "Das Nettoeinkommen muss größer als 0 € sein." };
    if (!isFinite(inp.statePension) || inp.statePension < 0) return { error: "Die gesetzliche Rente darf nicht negativ sein." };
    if (!isFinite(inp.yearsToRetirement) || inp.yearsToRetirement <= 0) return { error: "Die Jahre bis zur Rente müssen größer als 0 sein." };

    const targetIncome = inp.netIncome * (inp.targetPercent / 100);
    const monthlyGap = Math.max(0, targetIncome - inp.statePension);
    const capitalNeeded = monthlyGap * 12 * inp.payoutYears;

    const monthlyReturn = inp.expectedReturn / 100 / 12;
    const months = Math.round(inp.yearsToRetirement * 12);
    const futureValueExisting = inp.existingCapital * Math.pow(1 + monthlyReturn, months);
    const additionalCapitalNeeded = Math.max(0, capitalNeeded - futureValueExisting);

    let requiredMonthlySavings = 0;
    if (additionalCapitalNeeded > 0) {
      if (monthlyReturn > 0) {
        const factor = ((Math.pow(1 + monthlyReturn, months) - 1) / monthlyReturn) * (1 + monthlyReturn);
        requiredMonthlySavings = additionalCapitalNeeded / factor;
      } else {
        requiredMonthlySavings = additionalCapitalNeeded / months;
      }
    }

    return { targetIncome, monthlyGap, capitalNeeded, futureValueExisting, additionalCapitalNeeded, requiredMonthlySavings };
  }

  function initPensionGapCalculator() {
    const form = document.getElementById("rl-form");
    if (!form) return;

    function run() {
      const result = calculatePensionGap({
        netIncome: parseNumberInput(document.getElementById("rl-income")),
        targetPercent: parseNumberInput(document.getElementById("rl-target")),
        statePension: parseNumberInput(document.getElementById("rl-pension")),
        yearsToRetirement: parseNumberInput(document.getElementById("rl-years")),
        payoutYears: parseNumberInput(document.getElementById("rl-payoutyears")),
        existingCapital: parseNumberInput(document.getElementById("rl-existing")),
        expectedReturn: parseNumberInput(document.getElementById("rl-return"))
      });

      const errorEl = document.getElementById("rl-error");
      const resultsEl = document.getElementById("rl-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("rl-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Versorgungsziel pro Monat", formatEuro(result.targetIncome)));
      grid.appendChild(createResultItem("Monatliche Rentenlücke", formatEuro(result.monthlyGap), result.monthlyGap > 0 ? "negative" : "positive"));
      grid.appendChild(createResultItem("Kapitalbedarf zu Rentenbeginn", formatEuro(result.capitalNeeded)));
      grid.appendChild(createResultItem("Voraussichtlicher Wert vorhandenen Kapitals", formatEuro(result.futureValueExisting)));
      grid.appendChild(createResultItem("Zusätzlich benötigtes Kapital", formatEuro(result.additionalCapitalNeeded)));
      grid.appendChild(createResultItem("Erforderliche monatliche Sparrate", formatEuro(result.requiredMonthlySavings)));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("rl-results").hidden) run(); });

    document.getElementById("rl-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("rl-results").hidden = true;
      document.getElementById("rl-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("rl-results").hidden = false;
    run();
  }

  /* ======================================================================
     KREDITVERGLEICHSRECHNER
     ====================================================================== */

  function calculateLoanOffer(amount, annualRate, months, fee) {
    const monthlyRate = annualRate / 100 / 12;
    let monthlyPayment;
    if (monthlyRate > 0) {
      monthlyPayment = amount * (monthlyRate / (1 - Math.pow(1 + monthlyRate, -months)));
    } else {
      monthlyPayment = amount / months;
    }
    const totalPayment = monthlyPayment * months + fee;
    const totalCost = totalPayment - amount;
    return { monthlyPayment, totalPayment, totalCost };
  }

  function calculateLoanComparison(inp) {
    if (!isFinite(inp.amount) || inp.amount <= 0) return { error: "Die Kreditsumme muss größer als 0 € sein." };
    if (!isFinite(inp.months) || inp.months <= 0) return { error: "Die Laufzeit muss größer als 0 Monate sein." };
    if (!isFinite(inp.rateA) || inp.rateA < 0 || !isFinite(inp.rateB) || inp.rateB < 0) return { error: "Die Zinssätze dürfen nicht negativ sein." };

    const offerA = calculateLoanOffer(inp.amount, inp.rateA, inp.months, inp.feeA);
    const offerB = calculateLoanOffer(inp.amount, inp.rateB, inp.months, inp.feeB);
    const difference = offerA.totalPayment - offerB.totalPayment;
    const cheaper = difference === 0 ? null : (difference > 0 ? "B" : "A");

    return { offerA, offerB, difference, cheaper };
  }

  function initLoanComparisonCalculator() {
    const form = document.getElementById("kv-form");
    if (!form) return;

    function run() {
      const result = calculateLoanComparison({
        amount: parseNumberInput(document.getElementById("kv-amount")),
        months: parseNumberInput(document.getElementById("kv-months")),
        rateA: parseNumberInput(document.getElementById("kv-ratea")),
        feeA: parseNumberInput(document.getElementById("kv-feea")),
        rateB: parseNumberInput(document.getElementById("kv-rateb")),
        feeB: parseNumberInput(document.getElementById("kv-feeb"))
      });

      const errorEl = document.getElementById("kv-error");
      const resultsEl = document.getElementById("kv-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const gridA = document.getElementById("kv-result-a");
      clearChildren(gridA);
      gridA.appendChild(createResultItem("Monatliche Rate", formatEuro(result.offerA.monthlyPayment)));
      gridA.appendChild(createResultItem("Gesamtkosten (Zinsen + Gebühr)", formatEuro(result.offerA.totalCost)));
      gridA.appendChild(createResultItem("Gesamtrückzahlung", formatEuro(result.offerA.totalPayment)));

      const gridB = document.getElementById("kv-result-b");
      clearChildren(gridB);
      gridB.appendChild(createResultItem("Monatliche Rate", formatEuro(result.offerB.monthlyPayment)));
      gridB.appendChild(createResultItem("Gesamtkosten (Zinsen + Gebühr)", formatEuro(result.offerB.totalCost)));
      gridB.appendChild(createResultItem("Gesamtrückzahlung", formatEuro(result.offerB.totalPayment)));

      const summaryEl = document.getElementById("kv-summary");
      if (result.cheaper) {
        summaryEl.textContent = "Angebot " + result.cheaper + " ist über die Laufzeit günstiger um " + formatEuro(Math.abs(result.difference)) + ".";
      } else {
        summaryEl.textContent = "Beide Angebote sind über die Laufzeit gleich teuer.";
      }

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("kv-results").hidden) run(); });

    document.getElementById("kv-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("kv-results").hidden = true;
      document.getElementById("kv-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("kv-results").hidden = false;
    run();
  }

  /* ======================================================================
     INFLATIONSRECHNER
     ====================================================================== */

  function calculateInflation(inp) {
    if (!isFinite(inp.amount) || inp.amount <= 0) return { error: "Der Betrag muss größer als 0 € sein." };
    if (!isFinite(inp.years) || inp.years <= 0) return { error: "Die Anzahl Jahre muss größer als 0 sein." };
    if (!isFinite(inp.rate) || inp.rate < 0) return { error: "Die Inflationsrate darf nicht negativ sein." };

    const factor = Math.pow(1 + inp.rate / 100, inp.years);
    const futureAmountNeeded = inp.amount * factor;
    const purchasingPowerFuture = inp.amount / factor;
    const purchasingPowerLossPercent = (1 - 1 / factor) * 100;

    return { futureAmountNeeded, purchasingPowerFuture, purchasingPowerLossPercent };
  }

  function initInflationCalculator() {
    const form = document.getElementById("if-form");
    if (!form) return;

    function run() {
      const result = calculateInflation({
        amount: parseNumberInput(document.getElementById("if-amount")),
        years: parseNumberInput(document.getElementById("if-years")),
        rate: parseNumberInput(document.getElementById("if-rate"))
      });

      const errorEl = document.getElementById("if-error");
      const resultsEl = document.getElementById("if-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("if-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Nötiger Betrag in der Zukunft für gleiche Kaufkraft", formatEuro(result.futureAmountNeeded)));
      grid.appendChild(createResultItem("Heutige Kaufkraft dieses Betrags in der Zukunft", formatEuro(result.purchasingPowerFuture)));
      grid.appendChild(createResultItem("Kaufkraftverlust", formatPercent(result.purchasingPowerLossPercent, 1), "negative"));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("if-results").hidden) run(); });

    document.getElementById("if-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("if-results").hidden = true;
      document.getElementById("if-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("if-results").hidden = false;
    run();
  }

  /* ======================================================================
     UMZUGSKOSTENRECHNER
     ====================================================================== */

  const MOVING_SERVICE_RATES = {
    selbst: { perRoom: 50, perKm: 0.3, label: "Transport (Selbstumzug: Transporter, Sprit, Verpflegung)" },
    halb: { perRoom: 250, perKm: 1.0, label: "Umzugsunternehmen (Halbservice, ohne Ein-/Auspacken)" },
    komplett: { perRoom: 400, perKm: 1.2, label: "Umzugsunternehmen (Komplettservice inkl. Ein-/Auspacken)" }
  };

  function calculateMovingCosts(inp) {
    if (!isFinite(inp.rooms) || inp.rooms <= 0) return { error: "Die Zimmeranzahl muss größer als 0 sein." };
    if (!isFinite(inp.distance) || inp.distance < 0) return { error: "Die Entfernung darf nicht negativ sein." };
    if (!isFinite(inp.rent) || inp.rent < 0) return { error: "Die Kaltmiete darf nicht negativ sein." };
    if (!isFinite(inp.doubleMonths) || inp.doubleMonths < 0) return { error: "Die Monate doppelter Miete dürfen nicht negativ sein." };
    const rate = MOVING_SERVICE_RATES[inp.service];
    if (!rate) return { error: "Bitte wählen Sie eine Umzugsart aus." };

    const items = [];
    let total = 0;

    const baseCost = inp.rooms * rate.perRoom + inp.distance * rate.perKm;
    items.push({ label: rate.label, value: baseCost });
    total += baseCost;

    if (inp.renovation) {
      const c = inp.rooms * 150;
      items.push({ label: "Schönheitsreparaturen alte Wohnung", value: c });
      total += c;
    }
    if (inp.parking) {
      items.push({ label: "Halteverbotszone beantragen", value: 120 });
      total += 120;
    }
    if (inp.assembly) {
      items.push({ label: "Möbelmontage/-demontage durch Profis", value: 300 });
      total += 300;
    }
    if (inp.doubleMonths > 0 && inp.rent > 0) {
      const c = inp.rent * inp.doubleMonths;
      items.push({ label: "Doppelte Miete (Übergangszeit)", value: c });
      total += c;
    }

    return { items, total };
  }

  function initMovingCalculator() {
    const form = document.getElementById("um-form");
    if (!form) return;

    function run() {
      const result = calculateMovingCosts({
        rooms: parseNumberInput(document.getElementById("um-rooms")),
        distance: parseNumberInput(document.getElementById("um-distance")),
        service: document.getElementById("um-service").value,
        rent: parseNumberInput(document.getElementById("um-rent")),
        doubleMonths: parseNumberInput(document.getElementById("um-doublemonths")),
        renovation: document.getElementById("um-renovation").checked,
        parking: document.getElementById("um-parking").checked,
        assembly: document.getElementById("um-assembly").checked
      });

      const errorEl = document.getElementById("um-error");
      const resultsEl = document.getElementById("um-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("um-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Geschätzte Gesamtkosten", formatEuro(result.total)));

      const chart = document.getElementById("um-chart");
      clearChildren(chart);
      const maxVal = Math.max.apply(null, result.items.map(function (i) { return i.value; }).concat([1]));
      result.items.forEach(function (item) {
        const row = document.createElement("div");
        row.className = "bar-row";
        const labelRow = document.createElement("div");
        labelRow.className = "bar-row-label";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = item.label;
        const valSpan = document.createElement("span");
        valSpan.textContent = formatEuro(item.value);
        labelRow.appendChild(nameSpan);
        labelRow.appendChild(valSpan);
        const track = document.createElement("div");
        track.className = "bar-track";
        const fill = document.createElement("div");
        fill.className = "bar-fill ev";
        fill.style.width = Math.max(2, (item.value / maxVal) * 100) + "%";
        track.appendChild(fill);
        row.appendChild(labelRow);
        row.appendChild(track);
        chart.appendChild(row);
      });

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) {
      if (e.target && (e.target.type === "range" || e.target.type === "checkbox") && !document.getElementById("um-results").hidden) run();
    });
    form.addEventListener("change", function (e) { if (e.target.tagName === "SELECT") run(); });

    document.getElementById("um-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("um-results").hidden = true;
      document.getElementById("um-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("um-results").hidden = false;
    run();
  }

  /* ======================================================================
     OBJEKT-VERGLEICHSRECHNER (zwei Immobilien nebeneinander)
     ====================================================================== */

  function calculateObjectMetrics(price, area, rent) {
    const pricePerSqm = area > 0 ? price / area : null;
    const annualRent = rent * 12;
    const grossYield = price > 0 ? (annualRent / price) * 100 : null;
    return { price, area, rent, pricePerSqm, annualRent, grossYield };
  }

  function calculateObjectCompare(inp) {
    const fields = [inp.aPrice, inp.aArea, inp.aRent, inp.bPrice, inp.bArea, inp.bRent];
    if (fields.some(function (v) { return !isFinite(v) || v < 0; })) {
      return { error: "Bitte geben Sie für beide Objekte gültige, nicht-negative Werte ein." };
    }
    if (inp.aPrice <= 0 || inp.bPrice <= 0) return { error: "Der Kaufpreis muss bei beiden Objekten größer als 0 € sein." };
    if (inp.aArea <= 0 || inp.bArea <= 0) return { error: "Die Wohnfläche muss bei beiden Objekten größer als 0 m² sein." };

    const a = calculateObjectMetrics(inp.aPrice, inp.aArea, inp.aRent);
    const b = calculateObjectMetrics(inp.bPrice, inp.bArea, inp.bRent);

    const cheaperPerSqm = a.pricePerSqm === b.pricePerSqm ? null : (a.pricePerSqm < b.pricePerSqm ? "A" : "B");
    const higherYield = a.grossYield === b.grossYield ? null : (a.grossYield > b.grossYield ? "A" : "B");

    return { a, b, cheaperPerSqm, higherYield };
  }

  function initObjectCompareCalculator() {
    const form = document.getElementById("ov-form");
    if (!form) return;

    function run() {
      const result = calculateObjectCompare({
        aPrice: parseNumberInput(document.getElementById("ov-a-price")),
        aArea: parseNumberInput(document.getElementById("ov-a-area")),
        aRent: parseNumberInput(document.getElementById("ov-a-rent")),
        bPrice: parseNumberInput(document.getElementById("ov-b-price")),
        bArea: parseNumberInput(document.getElementById("ov-b-area")),
        bRent: parseNumberInput(document.getElementById("ov-b-rent"))
      });

      const errorEl = document.getElementById("ov-error");
      const resultsEl = document.getElementById("ov-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      function fillGrid(gridEl, obj, isWinnerSqm, isWinnerYield) {
        clearChildren(gridEl);
        gridEl.appendChild(createResultItem("Kaufpreis", formatEuro(obj.price)));
        gridEl.appendChild(createResultItem("Wohnfläche", formatNumber(obj.area, 0) + " m²"));
        gridEl.appendChild(createResultItem("Preis pro m²", formatEuro(obj.pricePerSqm) + (isWinnerSqm ? " (günstiger)" : ""), isWinnerSqm ? "positive" : ""));
        gridEl.appendChild(createResultItem("Jahreskaltmiete", formatEuro(obj.annualRent)));
        gridEl.appendChild(createResultItem("Bruttomietrendite", formatPercent(obj.grossYield, 2) + (isWinnerYield ? " (höher)" : ""), isWinnerYield ? "positive" : ""));
      }

      fillGrid(document.getElementById("ov-result-a"), result.a, result.cheaperPerSqm === "A", result.higherYield === "A");
      fillGrid(document.getElementById("ov-result-b"), result.b, result.cheaperPerSqm === "B", result.higherYield === "B");

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("ov-results").hidden) run(); });

    document.getElementById("ov-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("ov-results").hidden = true;
      document.getElementById("ov-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("ov-results").hidden = false;
    run();
  }

  /* ======================================================================
     BRUTTO-NETTO-RECHNER – Berechnungskern (reine Funktionen)
     Vereinfachte Modellrechnung auf Basis der amtlichen Eckwerte 2026
     (Grundfreibetrag, Tarifzonen § 32a EStG, Beitragsbemessungsgrenzen und
     -sätze der Sozialversicherung). Es handelt sich ausdrücklich NICHT um
     die exakte Lohnsteuertabelle: individuelle Frei-/Pauschbeträge (außer
     Werbungskosten-/Sonderausgaben-Pauschale und Entlastungsbetrag für
     Alleinerziehende), Kinderfreibeträge, private Krankenversicherung oder
     einmalige Bezüge (Weihnachts-/Urlaubsgeld) werden nicht berücksichtigt.
     ====================================================================== */

  function grundtarifSteuer(zve) {
    const zve0 = 12348, zve1 = 17799, zve2 = 69878, zve3 = 277826;
    const w2 = zve1 - zve0, w3 = zve2 - zve1;
    const tax1 = 0.19 * w2;
    const tax2 = tax1 + 0.33 * w3;
    if (zve <= zve0) return 0;
    if (zve <= zve1) {
      const x = zve - zve0;
      return 0.14 * x + (0.10 / w2) * 0.5 * x * x;
    }
    if (zve <= zve2) {
      const x = zve - zve1;
      return tax1 + 0.24 * x + (0.18 / w3) * 0.5 * x * x;
    }
    if (zve <= zve3) {
      return tax2 + 0.42 * (zve - zve2);
    }
    return tax2 + 0.42 * (zve3 - zve2) + 0.45 * (zve - zve3);
  }

  // Näherung für Steuerklasse V/VI: gleiche Zonenbreiten wie der Grundtarif,
  // aber ohne die steuerfreie Grundfreibetrags-Zone (kein Grundfreibetrag).
  function grundtarifSteuerOhneGrundfreibetrag(zve) {
    const w2 = 5451, w3 = 52079, top = 277826 - 12348;
    const tax1 = 0.19 * w2;
    const tax2 = tax1 + 0.33 * w3;
    if (zve <= 0) return 0;
    if (zve <= w2) {
      return 0.14 * zve + (0.10 / w2) * 0.5 * zve * zve;
    }
    if (zve <= w2 + w3) {
      const x = zve - w2;
      return tax1 + 0.24 * x + (0.18 / w3) * 0.5 * x * x;
    }
    if (zve <= top) {
      return tax2 + 0.42 * (zve - w2 - w3);
    }
    return tax2 + 0.42 * (top - w2 - w3) + 0.45 * (zve - top);
  }

  function calculateGrossNet(inp) {
    if (!isFinite(inp.grossMonthly) || inp.grossMonthly <= 0) {
      return { error: "Das monatliche Bruttogehalt muss größer als 0 € sein." };
    }
    if (inp.grossMonthly > 50000) {
      return { error: "Bitte geben Sie ein realistisches monatliches Bruttogehalt ein." };
    }

    const grossAnnual = inp.grossMonthly * 12;
    const RV_AV_BBG = 101400; // Beitragsbemessungsgrenze Renten-/Arbeitslosenversicherung 2026 (Jahr)
    const KV_PV_BBG = 69750;  // Beitragsbemessungsgrenze Kranken-/Pflegeversicherung 2026 (Jahr)

    const rvBase = Math.min(grossAnnual, RV_AV_BBG);
    const kvBase = Math.min(grossAnnual, KV_PV_BBG);

    const rv = rvBase * 0.093;   // Rentenversicherung, Arbeitnehmeranteil (18,6 % / 2)
    const av = rvBase * 0.013;   // Arbeitslosenversicherung, Arbeitnehmeranteil (2,6 % / 2)
    const kv = kvBase * 0.0875;  // Krankenversicherung inkl. Ø-Zusatzbeitrag, Arbeitnehmeranteil
    const pv = kvBase * (inp.childless ? 0.024 : 0.018); // Pflegeversicherung, ggf. Kinderlosenzuschlag
    const totalSV = rv + av + kv + pv;

    const taxClass = inp.taxClass || "1";
    let zve;
    if (taxClass === "6") {
      zve = Math.max(0, grossAnnual);
    } else {
      zve = Math.max(0, grossAnnual - 1230 - 36 - totalSV); // Werbungskosten-/Sonderausgabenpauschale + Vorsorgeaufwand (Näherung)
      if (taxClass === "2") zve = Math.max(0, zve - 4260); // Entlastungsbetrag für Alleinerziehende
    }

    let incomeTax;
    if (taxClass === "3") {
      incomeTax = grundtarifSteuer(zve / 2) * 2; // Splittingverfahren, Näherung: Partnereinkommen = 0
    } else if (taxClass === "5" || taxClass === "6") {
      incomeTax = grundtarifSteuerOhneGrundfreibetrag(zve);
    } else {
      incomeTax = grundtarifSteuer(zve);
    }
    incomeTax = Math.max(0, incomeTax);

    const soliFreigrenze = taxClass === "3" ? 40700 : 20350;
    let soli = 0;
    if (incomeTax > soliFreigrenze) {
      soli = Math.min(0.055 * incomeTax, 0.119 * (incomeTax - soliFreigrenze));
    }

    const churchRate = isFinite(inp.churchRate) ? inp.churchRate : 0;
    const churchTax = incomeTax * churchRate;

    const totalTaxes = incomeTax + soli + churchTax;
    const netAnnual = grossAnnual - totalSV - totalTaxes;
    const netMonthly = netAnnual / 12;

    return {
      grossMonthly: inp.grossMonthly, grossAnnual: grossAnnual,
      rv: rv, av: av, kv: kv, pv: pv, totalSV: totalSV,
      incomeTax: incomeTax, soli: soli, churchTax: churchTax, totalTaxes: totalTaxes,
      netAnnual: netAnnual, netMonthly: netMonthly
    };
  }

  function readGrossNetForm() {
    return {
      grossMonthly: parseNumberInput(document.getElementById("bn-gross")),
      taxClass: document.getElementById("bn-class").value,
      churchRate: parseFloat(document.getElementById("bn-church").value) || 0,
      childless: document.getElementById("bn-childless").checked
    };
  }

  function renderGrossNetResults(result) {
    const errorEl = document.getElementById("bn-error");
    const resultsEl = document.getElementById("bn-results");
    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      resultsEl.hidden = true;
      return;
    }
    errorEl.hidden = true;

    const grid = document.getElementById("bn-result-grid");
    clearChildren(grid);
    grid.appendChild(createResultItem("Nettogehalt pro Monat", formatEuro(result.netMonthly), "positive"));
    grid.appendChild(createResultItem("Nettogehalt pro Jahr", formatEuro(result.netAnnual), "positive"));
    grid.appendChild(createResultItem("Sozialabgaben pro Monat", formatEuro(result.totalSV / 12)));
    grid.appendChild(createResultItem("Steuern & Soli/Kirchensteuer pro Monat", formatEuro(result.totalTaxes / 12)));

    const chart = document.getElementById("bn-bar-chart");
    clearChildren(chart);
    const maxValue = Math.max(result.grossMonthly, 1);
    [
      ["Sozialabgaben (Renten-, Arbeitslosen-, Kranken-, Pflegeversicherung)", result.totalSV / 12, "ice"],
      ["Steuern (Lohnsteuer, Soli, ggf. Kirchensteuer)", result.totalTaxes / 12, "negative"],
      ["Auszahlung netto", result.netMonthly, "ev"]
    ].forEach(function (row) {
      const wrap = document.createElement("div");
      wrap.className = "bar-row";
      const labelRow = document.createElement("div");
      labelRow.className = "bar-row-label";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = row[0];
      const valSpan = document.createElement("span");
      valSpan.textContent = formatEuro(row[1]);
      labelRow.appendChild(nameSpan);
      labelRow.appendChild(valSpan);
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill " + row[2];
      fill.style.width = Math.max(0, Math.min(100, (row[1] / maxValue) * 100)) + "%";
      track.appendChild(fill);
      wrap.appendChild(labelRow);
      wrap.appendChild(track);
      chart.appendChild(wrap);
    });

    saveStammdaten({ netIncome: Math.round(result.netMonthly) });
    const bnStammHint = document.getElementById("bn-stammdaten-hint");
    if (bnStammHint) bnStammHint.hidden = false;

    const wasHidden = resultsEl.hidden;
    resultsEl.hidden = false;
    if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initGrossNetCalculator() {
    const form = document.getElementById("bn-form");
    if (!form) return;

    function run() {
      const result = calculateGrossNet(readGrossNetForm());
      renderGrossNetResults(result);
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) {
      if (e.target && (e.target.type === "range" || e.target.type === "checkbox")) run();
    });
    form.addEventListener("change", function (e) { if (e.target.tagName === "SELECT") run(); });

    document.getElementById("bn-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      run();
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("bn-results").hidden = false;
    run();
  }

  /* ======================================================================
     MACHBARKEITSRECHNER – Berechnungskern (reine Funktionen)
     Basis-Ergebnis (Überschuss/Sparpuffer) ist frei zugänglich. Die
     Vermögensentwicklung (ETF-Sparplan über die Jahre) ist Teil der
     Pro-Mitgliedschaft, siehe initFeasibilityCalculator().
     ====================================================================== */

  function calculateFeasibility(inp) {
    const fields = [inp.netIncome, inp.housing, inp.insurance, inp.energy, inp.otherFixed, inp.living];
    if (fields.some(function (v) { return !isFinite(v) || v < 0; })) {
      return { error: "Bitte geben Sie überall gültige, nicht-negative Werte ein." };
    }
    const totalExpenses = inp.housing + inp.insurance + inp.energy + inp.otherFixed + inp.living;
    const surplus = inp.netIncome - totalExpenses;
    const recommendedBuffer = totalExpenses * 3;
    return { netIncome: inp.netIncome, totalExpenses: totalExpenses, surplus: surplus, recommendedBuffer: recommendedBuffer };
  }

  function calculateFeasibilityWealth(inp) {
    if (!isFinite(inp.monthlyRate) || inp.monthlyRate < 0) {
      return { error: "Die monatliche Sparrate darf nicht negativ sein." };
    }
    if (!isFinite(inp.annualReturn) || inp.annualReturn < 0) {
      return { error: "Die erwartete Rendite darf nicht negativ sein." };
    }
    if (!isFinite(inp.years) || inp.years < 1) {
      return { error: "Der Anlagehorizont muss mindestens 1 Jahr betragen." };
    }
    const milestoneYears = [5, 10, 20, Math.round(inp.years)]
      .filter(function (y) { return y <= inp.years; })
      .filter(function (y, idx, arr) { return arr.indexOf(y) === idx; })
      .sort(function (a, b) { return a - b; });
    const milestones = milestoneYears.map(function (y) {
      const r = calculateCompoundInterest({ startCapital: 0, monthlyRate: inp.monthlyRate, annualInterest: inp.annualReturn, years: y });
      return { years: y, finalCapital: r.finalCapital, totalContributions: r.totalContributions, totalInterest: r.totalInterest };
    });
    const final = calculateCompoundInterest({ startCapital: 0, monthlyRate: inp.monthlyRate, annualInterest: inp.annualReturn, years: inp.years });
    return { milestones: milestones, final: final };
  }

  // Prueft, ob die Pro-Komplettversion (granulare Felder) gerade aktiv ist,
  // d.h. ob das Komplett-Fieldset eingeblendet wurde.
  function isFeasibilityKomplettActive() {
    const el = document.getElementById("m-komplett-fieldset");
    return !!(el && !el.hidden);
  }

  function readFeasibilityForm() {
    if (isFeasibilityKomplettActive()) {
      // Komplettversion (Pro): granulare Felder werden auf dieselbe Signatur
      // wie die Basisversion abgebildet, damit calculateFeasibility() unveraendert bleibt.
      const groceries = parseNumberInput(document.getElementById("m-k-groceries"));
      const leisure = parseNumberInput(document.getElementById("m-k-leisure"));
      const mobility = parseNumberInput(document.getElementById("m-k-mobility"));
      const otherFixedK = parseNumberInput(document.getElementById("m-k-otherfixed"));
      return {
        netIncome: parseNumberInput(document.getElementById("m-netto")),
        housing: parseNumberInput(document.getElementById("m-k-housing")),
        insurance: parseNumberInput(document.getElementById("m-k-insurance")),
        energy: parseNumberInput(document.getElementById("m-k-energy")),
        otherFixed: mobility + otherFixedK,
        living: groceries + leisure
      };
    }
    return {
      netIncome: parseNumberInput(document.getElementById("m-netto")),
      housing: parseNumberInput(document.getElementById("m-housing")),
      insurance: parseNumberInput(document.getElementById("m-insurance")),
      energy: parseNumberInput(document.getElementById("m-energy")),
      otherFixed: parseNumberInput(document.getElementById("m-other")),
      living: parseNumberInput(document.getElementById("m-living"))
    };
  }

  function renderFeasibilityResults(result) {
    const errorEl = document.getElementById("m-error");
    const resultsEl = document.getElementById("m-results");
    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      resultsEl.hidden = true;
      return;
    }
    errorEl.hidden = true;

    const grid = document.getElementById("m-result-grid");
    clearChildren(grid);
    grid.appendChild(createResultItem("Monatlicher Überschuss", formatEuro(result.surplus), result.surplus >= 0 ? "positive" : "negative"));
    grid.appendChild(createResultItem("Monatliche Gesamtausgaben", formatEuro(result.totalExpenses)));
    grid.appendChild(createResultItem("Empfohlener Sparpuffer (3 Monatsausgaben)", formatEuro(result.recommendedBuffer)));

    const noteEl = document.getElementById("m-note");
    if (noteEl) {
      noteEl.hidden = false;
      if (result.surplus < 0) {
        noteEl.textContent = "Ihre monatlichen Ausgaben übersteigen aktuell Ihr Einkommen. Prüfen Sie, welche Kostenblöcke sich reduzieren lassen, bevor Sie zusätzliche feste Verpflichtungen wie eine Immobilie eingehen.";
      } else if (result.surplus * 12 < result.recommendedBuffer) {
        noteEl.textContent = "Sie haben monatlich Spielraum. Bauen Sie zunächst den empfohlenen Sparpuffer von 3 Monatsausgaben auf, bevor Sie größere Beträge langfristig anlegen.";
      } else {
        noteEl.textContent = "Ihr monatlicher Überschuss ist positiv und der Sparpuffer wäre rechnerisch innerhalb eines Jahres erreichbar. In der Vermögensentwicklung unten sehen Sie, wie sich ein Teil davon über die Jahre in einem ETF-Sparplan entwickeln könnte.";
      }
    }

    const wealthRateInput = document.getElementById("m-etf-rate");
    if (wealthRateInput && result.surplus > 0 && wealthRateInput.dataset.touched !== "true") {
      const maxAttr = parseFloat(wealthRateInput.max);
      const suggested = Math.min(Math.round(result.surplus), isFinite(maxAttr) ? maxAttr : result.surplus);
      wealthRateInput.value = Math.max(0, suggested);
      updateSliderDisplay(wealthRateInput);
    }

    const wasHidden = resultsEl.hidden;
    resultsEl.hidden = false;
    if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderFeasibilityWealth(result) {
    const grid = document.getElementById("m-wealth-grid");
    clearChildren(grid);
    if (result.error) {
      grid.appendChild(createResultItem("Hinweis", result.error));
      return;
    }
    result.milestones.forEach(function (m) {
      grid.appendChild(createResultItem("Vermögen nach " + m.years + (m.years === 1 ? " Jahr" : " Jahren"), formatEuro(m.finalCapital), "positive"));
    });
    grid.appendChild(createResultItem("Davon eingezahlt", formatEuro(result.final.totalContributions)));
    grid.appendChild(createResultItem("Davon Rendite", formatEuro(result.final.totalInterest), "positive"));
  }

  function initFeasibilityCalculator() {
    const form = document.getElementById("m-form");
    if (!form) return;

    function run() {
      const result = calculateFeasibility(readFeasibilityForm());
      renderFeasibilityResults(result);
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range") run(); });

    const resetBtn = document.getElementById("m-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        form.reset();
        initSliders(form);
        document.getElementById("m-results").hidden = true;
        document.getElementById("m-error").hidden = true;
        const wealthResultsEl = document.getElementById("m-wealth-results");
        const wealthLockedEl = document.getElementById("m-wealth-locked");
        if (wealthResultsEl) wealthResultsEl.hidden = true;
        if (wealthLockedEl) wealthLockedEl.hidden = false;
        const wealthRateInput = document.getElementById("m-etf-rate");
        if (wealthRateInput) wealthRateInput.dataset.touched = "false";
        const kGroceriesResetInput = document.getElementById("m-k-groceries");
        if (kGroceriesResetInput) {
          kGroceriesResetInput.dataset.touched = "false";
          const kPersonsResetInput = document.getElementById("m-k-persons");
          if (kPersonsResetInput) setSliderValue("m-k-groceries", suggestGroceryCost(parseNumberInput(kPersonsResetInput)));
        }
      });
    }

    // Komplettversion (Pro): granulare Kostenarten statt Pauschalsummen,
    // inkl. Lebensmittel-Autovorschlag nach Haushaltsgroesse und Stammdaten-Autofill.
    const komplettBtn = document.getElementById("m-komplett-btn");
    const komplettLocked = document.getElementById("m-komplett-locked");
    const basicFieldset = document.getElementById("m-basic-fieldset");
    const komplettFieldset = document.getElementById("m-komplett-fieldset");
    const kPersonsInput = document.getElementById("m-k-persons");
    const kGroceriesInput = document.getElementById("m-k-groceries");

    function applyGroceriesSuggestion() {
      if (!kPersonsInput || !kGroceriesInput) return;
      if (kGroceriesInput.dataset.touched === "true") return;
      const persons = parseNumberInput(kPersonsInput);
      setSliderValue("m-k-groceries", suggestGroceryCost(persons));
    }

    function prefillKomplettFromStammdaten() {
      const data = getStammdaten();
      if (hasStammdatenValue("netIncome")) setSliderValue("m-netto", data.netIncome);
      if (hasStammdatenValue("housingCost")) setSliderValue("m-k-housing", data.housingCost);
      if (hasStammdatenValue("energyCost")) setSliderValue("m-k-energy", data.energyCost);
      if (hasStammdatenValue("householdSize")) setSliderValue("m-k-persons", data.householdSize);
      applyGroceriesSuggestion();
    }

    if (komplettBtn) {
      komplettBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (!checkProAccessOrPrompt("Machbarkeitsrechner-Komplettversion")) return;
        if (komplettLocked) komplettLocked.hidden = true;
        if (basicFieldset) basicFieldset.hidden = true;
        if (komplettFieldset) {
          komplettFieldset.hidden = false;
          initSliders(komplettFieldset);
        }
        prefillKomplettFromStammdaten();
        run();
      });
    }

    if (kPersonsInput) {
      kPersonsInput.addEventListener("input", function () { applyGroceriesSuggestion(); });
    }
    if (kGroceriesInput) {
      kGroceriesInput.addEventListener("input", function () { kGroceriesInput.dataset.touched = "true"; });
    }

    const ecarCheck = document.getElementById("m-ecar");
    const ecarTip = document.getElementById("m-ecar-tip");
    if (ecarCheck && ecarTip) {
      ecarCheck.addEventListener("change", function () { ecarTip.hidden = !ecarCheck.checked; });
    }
    const heatpumpCheck = document.getElementById("m-heatpump");
    const heatpumpTip = document.getElementById("m-heatpump-tip");
    if (heatpumpCheck && heatpumpTip) {
      heatpumpCheck.addEventListener("change", function () { heatpumpTip.hidden = !heatpumpCheck.checked; });
    }

    function runWealth() {
      const wealthResult = calculateFeasibilityWealth({
        monthlyRate: parseNumberInput(document.getElementById("m-etf-rate")),
        annualReturn: parseNumberInput(document.getElementById("m-etf-return")),
        years: parseNumberInput(document.getElementById("m-etf-years"))
      });
      renderFeasibilityWealth(wealthResult);
    }

    const wealthBtn = document.getElementById("m-wealth-btn");
    const wealthForm = document.getElementById("m-wealth-form");
    const wealthRateInput = document.getElementById("m-etf-rate");
    if (wealthRateInput) {
      wealthRateInput.addEventListener("input", function () { wealthRateInput.dataset.touched = "true"; });
    }
    if (wealthBtn) {
      wealthBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (!checkProAccessOrPrompt("Vermögensentwicklung (ETF-Sparplan) im Machbarkeitsrechner")) return;
        runWealth();
        document.getElementById("m-wealth-locked").hidden = true;
        document.getElementById("m-wealth-results").hidden = false;
      });
    }
    if (wealthForm) {
      wealthForm.addEventListener("input", function (e) {
        const resultsVisible = document.getElementById("m-wealth-results") && !document.getElementById("m-wealth-results").hidden;
        if (e.target && e.target.type === "range" && resultsVisible) {
          if (!checkProAccessOrPrompt("Vermögensentwicklung (ETF-Sparplan) im Machbarkeitsrechner")) return;
          runWealth();
        }
      });
    }

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("m-results").hidden = false;
    run();
  }

  /* ======================================================================
     GESAMTPLANRECHNER (Pro) – führt Stammdaten aus mehreren Rechnern
     (Brutto-Netto, Hauskosten, Strom-&-Gas, PV, E-Auto) zu einem
     monatlichen Gesamtbild zusammen. Reine Zusammenfassung, keine neue
     Berechnung - siehe README "Stammdaten".
     ====================================================================== */

  const GESAMTPLAN_FIELDS = [
    { key: "netIncome", label: "Nettoeinkommen", sign: 1, source: "Brutto-Netto-Rechner", href: "brutto-netto-rechner.html" },
    { key: "housingCost", label: "Wohnkosten", sign: -1, source: "Hauskostenrechner", href: "../immobilien/hauskosten-rechner.html" },
    { key: "energyCost", label: "Energiekosten (Strom/Gas)", sign: -1, source: "Strom-&-Gas-Sparrechner", href: "../vertraege/strom-gas.html" },
    { key: "pvMonthlyBenefit", label: "PV-Ersparnis", sign: 1, source: "PV-Rechner", href: "../energie/pv-rechner.html" },
    { key: "evMonthlySavings", label: "E-Auto-Ersparnis", sign: 1, source: "E-Auto-Rechner", href: "../energie/eauto-rechner.html" }
  ];

  // Reine Funktion (kein I/O) - sicher fuer Selbsttests: summiert die
  // bekannten Stammdaten-Werte zu einem monatlichen Gesamtsaldo.
  function calculateGesamtplan(data) {
    const d = data && typeof data === "object" ? data : {};
    let total = 0;
    let knownCount = 0;
    GESAMTPLAN_FIELDS.forEach(function (field) {
      const v = d[field.key];
      if (typeof v === "number" && isFinite(v)) {
        knownCount++;
        total += field.sign * v;
      }
    });
    return { total: total, knownCount: knownCount, totalFields: GESAMTPLAN_FIELDS.length };
  }

  function initGesamtplanCalculator() {
    const lockedBox = document.getElementById("gp-locked");
    const contentBox = document.getElementById("gp-content");
    const unlockBtn = document.getElementById("gp-unlock-btn");
    const refreshBtn = document.getElementById("gp-refresh-btn");
    if (!unlockBtn || !contentBox) return;

    function render() {
      const data = getStammdaten();

      const sourcesGrid = document.getElementById("gp-sources-grid");
      clearChildren(sourcesGrid);
      GESAMTPLAN_FIELDS.forEach(function (field) {
        const v = data[field.key];
        if (typeof v === "number" && isFinite(v)) {
          sourcesGrid.appendChild(createResultItem(field.label + " (" + field.source + ")", formatEuro(v) + " / Monat", "positive"));
        } else {
          const item = createResultItem(field.label + " (" + field.source + ")", "noch nicht ermittelt");
          sourcesGrid.appendChild(item);
        }
      });

      const result = calculateGesamtplan(data);
      const totalGrid = document.getElementById("gp-total-grid");
      clearChildren(totalGrid);
      totalGrid.appendChild(createResultItem(
        "Monatlicher Gesamteffekt",
        formatEuro(result.total),
        (result.total >= 0 ? "positive" : "negative") + " highlight"
      ));

      const completenessEl = document.getElementById("gp-completeness");
      if (completenessEl) {
        completenessEl.textContent = result.knownCount + " von " + result.totalFields + " Werten bereits ermittelt." +
          (result.knownCount < result.totalFields ? " Nutzen Sie die verlinkten Rechner oben, um Ihr Gesamtbild zu vervollständigen." : " Ihr Gesamtbild ist vollständig.");
      }
    }

    unlockBtn.addEventListener("click", function (e) {
      e.preventDefault();
      if (!checkProAccessOrPrompt("Gesamtplanrechner")) return;
      lockedBox.hidden = true;
      contentBox.hidden = false;
      render();
    });

    if (refreshBtn) {
      refreshBtn.addEventListener("click", function (e) {
        e.preventDefault();
        render();
      });
    }
  }


  /* ===================== Pro-Mitgliedschaft: Freischalt-Hinweise ===================== */

  // Prüft, ob der Nutzer Pro-Zugang hat; zeigt andernfalls den passenden
  // Hinweisdialog (nicht eingerichtet / nicht angemeldet / kein Pro) und
  // gibt false zurück. Wird sowohl von generischen [data-pro-gate]-Buttons
  // als auch von echten Pro-Funktionen (z. B. Machbarkeitsrechner) genutzt.
  function checkProAccessOrPrompt(label) {
    return true; // Geldhirn: alle Funktionen kostenlos
    if (!isBackendReady()) {
      showModal(
        "Teil der Pro-Mitgliedschaft",
        "„" + label + "“ ist Teil der Geldhirn-Pro-Mitgliedschaft für 4,99 € im Monat (erste 7 Tage kostenlos testen). Rufen Sie dazu die Seite „Mitgliedschaft“ in der Navigation auf. Hinweis: Die Pro-Mitgliedschaft ist im MVP eine Vorschau und noch nicht buchbar (siehe SETUP.md, um Login und Abrechnung anzubinden)."
      );
      return false;
    }
    if (!currentUser) {
      showModal("Anmeldung erforderlich", "„" + label + "“ steht Pro-Mitgliedern zur Verfügung. Bitte melden Sie sich zuerst an, dann prüfen wir Ihren Mitgliedschaftsstatus automatisch.");
      return false;
    }
    if (!hasProAccess()) {
      showModal("Teil der Pro-Mitgliedschaft", "„" + label + "“ ist Teil der Geldhirn-Pro-Mitgliedschaft für 4,99 € im Monat (erste 7 Tage kostenlos testen). Rufen Sie dazu die Seite „Mitgliedschaft“ auf, um zu upgraden.");
      return false;
    }
    return true;
  }

  function initProGateButtons() {
    document.querySelectorAll("[data-pro-gate]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const label = btn.getAttribute("data-pro-gate");
        if (!checkProAccessOrPrompt(label)) return;
        showModal("Pro-Zugang erkannt", "Ihre Pro-Mitgliedschaft wurde erfolgreich geprüft. Die eigentliche Export-/Download-Funktion für „" + label + "“ folgt in einer der nächsten Ausbaustufen.");
      });
    });
  }

  /* ===================== Rechnerübersicht ===================== */
  /* Hinweis: href-Werte sind relativ zur Startseite (index.html im Wurzelverzeichnis),
     da die Übersichtskarten aktuell nur dort eingebunden werden. */

  const CALCULATORS = [
    {
      title: "Umzugskostenrechner", status: "live",
      desc: "Umzugskosten je nach Zimmeranzahl, Entfernung und Umzugsart realistisch abschätzen.",
      href: "immobilien/umzugskosten-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M3 16V8a1 1 0 011-1h9v9M3 16h10M3 16v2h2M13 16h4a1 1 0 001-1v-3l-3-4h-2v7M17 18a2 2 0 11-4 0 2 2 0 014 0zM7 18a2 2 0 11-4 0 2 2 0 014 0z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Objekt-Vergleichsrechner", status: "live",
      desc: "Zwei Immobilien anhand Preis pro m² und Bruttomietrendite direkt gegenüberstellen.",
      href: "immobilien/objekt-vergleich.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="3" y="4" width="7" height="16" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="7" height="16" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M10 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    },
    {
      title: "Immobilien-Sofortcheck", status: "live",
      desc: "Kaufnebenkosten, Finanzierung, laufende Kosten und Rendite auf einen Blick.",
      href: "immobilien/index.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 11L12 4l8 7M6 10v9h12v-9" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "PV-Rechner mit Speicher", status: "live",
      desc: "Eigenverbrauch, Einspeisung und Amortisation Ihrer PV-Anlage – mit und ohne Batteriespeicher.",
      href: "energie/pv-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z" stroke="currentColor" stroke-width="1.8"/></svg>'
    },
    {
      title: "E-Auto-Rechner", status: "live",
      desc: "Kostenvergleich Elektroauto gegen Verbrenner über die Haltedauer, inklusive Ersparnis durch eigene PV-Anlage.",
      href: "energie/eauto-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 16h16M6 16v3M18 16v3M5 16l1.5-5h11L19 16M9 7l1 2h4l1-2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Zinseszinsrechner", status: "live",
      desc: "Endkapital, eingezahltes Kapital und Zinsertrag bei Sparplänen mit Zinseszins berechnen.",
      href: "finanzen/zinseszins-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 19V5M4 19h16M8 16l3-6 3 4 4-8" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Entnahmeplanrechner", status: "live",
      desc: "Wie lange reicht Ihr Kapital bei einer gewünschten monatlichen Entnahme?",
      href: "finanzen/entnahmeplan-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    },
    {
      title: "Wärmepumpen-Check", status: "live",
      desc: "Erste Einschätzung zur Eignung einer Wärmepumpe anhand Dämmstandard und Wärmeverteilung.",
      href: "energie/waermepumpen-check.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" stroke="currentColor" stroke-width="1.8"/></svg>'
    },
    {
      title: "Sanierungskostenrechner", status: "live",
      desc: "Kosten geplanter Sanierungsmaßnahmen wie Dach, Fassade, Fenster und Heizung abschätzen.",
      href: "energie/sanierungskosten-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 20l6-6M9 15l7-7 3 3-7 7-3-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Mietrenditerechner", status: "live",
      desc: "Brutto- und Nettomietrendite sowie Eigenkapitalrendite einer vermieteten Immobilie berechnen.",
      href: "immobilien/mietrendite-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 19V5M4 19h16M8 15l3-4 3 3 4-6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Mieten-oder-kaufen-Rechner", status: "live",
      desc: "Vermögensvergleich zwischen Immobilienkauf und Mieten mit Anlage der Differenz.",
      href: "immobilien/mieten-oder-kaufen-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    },
    {
      title: "Hauskostenrechner", status: "live",
      desc: "Übersicht aller laufenden Kosten eines Hauses pro Jahr, Monat und Quadratmeter.",
      href: "immobilien/hauskosten-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="4" y="9" width="16" height="11" stroke="currentColor" stroke-width="1.8"/><path d="M4 9l8-6 8 6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Versicherungs-Kostenorientierung", status: "live",
      desc: "Erste Orientierung, ob Ihr Versicherungsbeitrag im üblichen Vergleichsrahmen liegt.",
      href: "vertraege/versicherungs-check.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Sparplanrechner", status: "live",
      desc: "Zielkapital-Planung: Wie entwickelt sich mein Sparplan mit monatlicher Rate und Rendite?",
      href: "finanzen/sparplan-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M12 3v18M5 8l7-5 7 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Rentenlückenrechner", status: "live",
      desc: "Differenz zwischen gewünschtem Ruhestandseinkommen und gesetzlicher Rente abschätzen.",
      href: "finanzen/rentenluecken-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 4v16h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 15l0 3M13 11l0 7M18 7l0 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    },
    {
      title: "Kreditvergleichsrechner", status: "live",
      desc: "Ratenkredite anhand effektivem Jahreszins und Gesamtkosten vergleichen.",
      href: "finanzen/kredit-vergleich-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18" stroke="currentColor" stroke-width="1.8"/></svg>'
    },
    {
      title: "Inflationsrechner", status: "live",
      desc: "Kaufkraftverlust eines Geldbetrags über die Zeit berechnen.",
      href: "finanzen/inflations-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M6 6l12 12M6 18L18 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    },
    {
      title: "Brutto-Netto-Rechner", status: "live",
      desc: "Monatliches Nettogehalt aus Bruttogehalt, Steuerklasse und Sozialabgaben abschätzen.",
      href: "finanzen/brutto-netto-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 10h4M7 14h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    },
    {
      title: "Machbarkeitsrechner", status: "live",
      desc: "Nettoeinkommen und alle festen Kosten gegenüberstellen: monatlicher Überschuss, Sparpuffer und Vermögensentwicklung (Pro).",
      href: "finanzen/machbarkeitsrechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 12l4-4 4 4 8-8M20 4v5h-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Baufinanzierungsrechner", status: "live",
      desc: "Monatliche Rate, gezahlte Zinsen und Restschuld eines Annuitätendarlehens über die Zinsbindung berechnen.",
      href: "immobilien/baufinanzierung-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 20h16M6 20V10l6-5 6 5v10M10 20v-6h4v6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
    },
    {
      title: "Auto-Leasing & Finanzierung", status: "live",
      desc: "Leasing gegen Kauf mit Kredit vergleichen: Gesamtkosten über die Laufzeit inklusive Restwert.",
      href: "energie/autofinanzierung-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 16h16M6 16v3M18 16v3M5 16l1.5-5h11L19 16" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    },
    {
      title: "Benzinkostenrechner", status: "live",
      desc: "Kraftstoffkosten pro Monat und Jahr anhand Fahrleistung, Verbrauch und Spritpreis berechnen.",
      href: "energie/benzinkosten-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M5 20V6a1 1 0 011-1h6a1 1 0 011 1v14M5 20h8M15 9h2l2 2v6a1 1 0 01-1 1h-1" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="17.5" cy="17" r="1" stroke="currentColor" stroke-width="1.4"/></svg>'
    },
    {
      title: "Umsatzsteuerrechner", status: "live",
      desc: "Netto- und Bruttobeträge bei 19 % oder 7 % Umsatzsteuer in beide Richtungen umrechnen.",
      href: "finanzen/umsatzsteuer-rechner.html",
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="17" cy="17" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19 5L5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    }
  ];

  function renderCalculatorCards(list, grid) {
    clearChildren(grid);

    list.forEach(function (calc) {
      const card = document.createElement("article");
      card.className = "calc-card";

      const iconWrap = document.createElement("div");
      iconWrap.className = "calc-card-icon";
      iconWrap.innerHTML = calc.icon; // statische, fest im Code hinterlegte SVG-Icons, keine Nutzereingabe
      card.appendChild(iconWrap);

      const h3 = document.createElement("h3");
      h3.textContent = calc.title;
      card.appendChild(h3);

      const p = document.createElement("p");
      p.textContent = calc.desc;
      card.appendChild(p);

      const statusSpan = document.createElement("span");
      statusSpan.className = "calc-status " + (calc.status === "live" ? "status-live" : "status-soon");
      statusSpan.textContent = calc.status === "live" ? "Verfügbar" : "In Vorbereitung";
      card.appendChild(statusSpan);

      const btn = document.createElement(calc.status === "live" ? "a" : "button");
      btn.className = "btn btn-outline";
      btn.textContent = calc.status === "live" ? "Rechner öffnen" : "Mehr erfahren";
      if (calc.status === "live") {
        btn.setAttribute("href", calc.href);
      } else {
        btn.setAttribute("type", "button");
        btn.addEventListener("click", function () {
          showModal(calc.title, "Dieser Rechner wird aktuell vorbereitet.");
        });
      }
      card.appendChild(btn);

      grid.appendChild(card);
    });
  }

  function renderCalculatorOverview() {
    const grid = document.getElementById("calc-overview-grid");
    if (grid) renderCalculatorCards(CALCULATORS, grid);
  }

  /* ===================== Demo-Bestellbuttons Objektanalyse ===================== */

  function initPricingDemoButtons() {
    document.querySelectorAll("[data-demo-order]").forEach(function (btn) {
      // Buttons mit data-stripe-checkout werden, sobald für ihre konkrete
      // Plan-Variante (monatlich/jährlich) ein echter Stripe Payment Link
      // hinterlegt ist, von initStripeCheckoutButtons() übernommen (echte
      // Weiterleitung statt Demo-Hinweis) – hier dann übersprungen.
      const planAttr = btn.getAttribute("data-stripe-checkout");
      if (planAttr && stripePlanFor(planAttr).configured) {
        return;
      }
      btn.addEventListener("click", function () {
        showModal(btn.getAttribute("data-demo-order"), "Diese Funktion wird in einer künftigen Version mit echtem Backend angebunden. Im MVP werden dafür keine Daten gespeichert oder übertragen.");
      });
    });
  }

  /* ===================== Stripe: Pro-Upgrade & Kontoverwaltung ===================== */

  function initStripeCheckoutButtons() {
    document.querySelectorAll("[data-stripe-checkout]").forEach(function (btn) {
      const plan = stripePlanFor(btn.getAttribute("data-stripe-checkout"));
      if (!plan.configured) return;
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        let url = plan.url;
        const params = [];
        if (currentUser && currentUser.email) params.push("prefilled_email=" + encodeURIComponent(currentUser.email));
        if (currentUser && currentUser.id) params.push("client_reference_id=" + encodeURIComponent(currentUser.id));
        if (params.length) url += (url.indexOf("?") === -1 ? "?" : "&") + params.join("&");
        window.location.href = url;
      });
    });
  }

  function initStripePortalButtons() {
    if (!CONFIG.isStripePortalConfigured()) return;
    document.querySelectorAll("[data-account-action]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        window.open(CONFIG.stripeCustomerPortalUrl, "_blank", "noopener");
      });
    });
  }

  /* ===================== Exposé-Upload-Demo ===================== */

  function initExposeUpload() {
    const form = document.getElementById("expose-form");
    if (!form) return;

    const fileInput = document.getElementById("expose-file");
    const fileInfo = document.getElementById("expose-file-info");
    const errorEl = document.getElementById("expose-error");
    const summaryEl = document.getElementById("expose-summary");

    const MAX_SIZE_BYTES = 15 * 1024 * 1024;
    const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

    fileInput.addEventListener("change", function () {
      const file = fileInput.files[0];
      if (!file) { fileInfo.textContent = ""; return; }
      const sizeKb = Math.round(file.size / 1024);
      fileInfo.textContent = "Ausgewählt: " + file.name + " (" + sizeKb + " KB)";
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      summaryEl.hidden = true;

      const file = fileInput.files[0];
      const email = document.getElementById("expose-email").value.trim();

      if (!file) {
        errorEl.textContent = "Bitte wählen Sie eine Exposé-Datei aus (PDF oder Bild).";
        errorEl.hidden = false;
        return;
      }
      if (ALLOWED_TYPES.indexOf(file.type) === -1) {
        errorEl.textContent = "Es sind nur PDF- oder Bilddateien zulässig.";
        errorEl.hidden = false;
        return;
      }
      if (file.size > MAX_SIZE_BYTES) {
        errorEl.textContent = "Die Datei ist zu groß. Maximal zulässig sind 15 MB.";
        errorEl.hidden = false;
        return;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorEl.textContent = "Bitte geben Sie eine gültige E-Mail-Adresse ein oder lassen Sie das Feld leer.";
        errorEl.hidden = false;
        return;
      }

      /* --------------------------------------------------------------
         TODO FUTURE (noch nicht implementiert):
         1. Upload in geschützten Supabase Storage
         2. Webhook an n8n
         3. Dokumentextraktion über OpenAI API oder Claude API
         4. Berechnung über festen, deterministischen Rechenkern
            (Formeln bleiben immer programmierter Code, keine KI-Formeln)
         5. Berichtserstellung
         6. PDF-Generierung
         7. Automatischer E-Mail-Versand
         Aktuell: keine echte Übertragung, nur lokale Demo-Zusammenfassung.
      -------------------------------------------------------------- */

      clearChildren(summaryEl);
      const heading = document.createElement("h3");
      heading.textContent = "Demo-Zusammenfassung (keine echte KI-Auswertung)";
      summaryEl.appendChild(heading);

      const note = document.createElement("p");
      note.className = "notice-box";
      note.textContent = "Dies ist eine Vorschau der künftigen Funktion. Es wurde noch keine Datei übertragen und keine echte Analyse durchgeführt.";
      summaryEl.appendChild(note);

      const grid = document.createElement("div");
      grid.className = "result-grid";
      grid.appendChild(createResultItem("Dateiname", file.name));
      grid.appendChild(createResultItem("Dateigröße", Math.round(file.size / 1024) + " KB"));
      grid.appendChild(createResultItem("Nutzungsart", document.getElementById("expose-usage").value === "eigennutzung" ? "Eigennutzung" : "Kapitalanlage"));
      summaryEl.appendChild(grid);

      summaryEl.hidden = false;
      summaryEl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ===================== Objektfinder-Formular (Demo) ===================== */

  function initFinderForm() {
    const form = document.getElementById("finder-form");
    if (!form) return;
    const errorEl = document.getElementById("finder-error");
    const dealTypeSelect = document.getElementById("f-dealtype");

    // Kauf/Miete-Umschaltung: zeigt Kaufpreis- oder Kaltmiete-Felder, blendet
    // kauf-spezifische Felder (Rendite, Eigennutzung/Kapitalanlage) bei einer
    // Mietsuche aus, da sie dort nicht relevant sind.
    function updateDealTypeVisibility() {
      if (!dealTypeSelect) return;
      const isMiete = dealTypeSelect.value === "miete";
      const kaufFields = ["f-pricefrom-field", "f-priceto-field", "f-usage-field", "f-yield-field"];
      const mieteFields = ["f-rentfrom-field", "f-rentto-field"];
      kaufFields.forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.hidden = isMiete;
      });
      mieteFields.forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.hidden = !isMiete;
      });
    }

    if (dealTypeSelect) {
      dealTypeSelect.addEventListener("change", updateDealTypeVisibility);
      updateDealTypeVisibility();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;

      const region = document.getElementById("f-region").value.trim();
      const email = document.getElementById("f-email").value.trim();

      if (!region) {
        errorEl.textContent = "Bitte geben Sie eine Stadt oder Region an.";
        errorEl.hidden = false;
        return;
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorEl.textContent = "Bitte geben Sie eine gültige E-Mail-Adresse ein.";
        errorEl.hidden = false;
        return;
      }

      // TODO FUTURE: Übermittlung an API_ENDPOINTS.objectFinder via n8n-Webhook,
      // sobald Suche technisch und rechtlich freigeschaltet ist.
      const isMiete = dealTypeSelect && dealTypeSelect.value === "miete";
      const successText = isMiete
        ? "Ihr Suchprofil für eine Mietwohnung wurde in dieser Demo-Version lokal erfasst. Die konkrete automatisierte Suche wird erst nach technischer und rechtlicher Freischaltung aktiviert."
        : "Ihr Suchprofil wurde in dieser Demo-Version lokal erfasst. Die konkrete automatisierte Suche wird erst nach technischer und rechtlicher Freischaltung aktiviert.";
      showModal("Suchprofil angelegt (Demo)", successText);
      form.reset();
      updateDealTypeVisibility();
    });
  }

  /* ===================== Strom- & Gas-Formular (Demo) ===================== */

  /* ======================================================================
     STROM- & GAS-SPARRECHNER
     Bundesdurchschnittswerte für Jahresverbrauch nach Haushaltsgröße sowie
     für Bestands-/Grundversorgungs- und Neukunden-/Wechseltarife. Grobe,
     gerundete Näherungswerte auf Basis marktüblicher Vergleichsportale und
     Verbandsdaten (u. a. BDEW, co2online, Stromspiegel), Stand 2026.
     Tatsächliche Werte hängen stark von Region, Gebäude und Verhalten ab
     und werden hier nur als Ausgangspunkt vorgeschlagen – frei anpassbar.
     ====================================================================== */

  const ENERGY_BENCHMARKS = {
    strom: {
      label: "Strom",
      consumptionByPersons: { 1: 1600, 2: 2500, 3: 3500, 4: 4250, 5: 5000, 6: 5700, 7: 6400 },
      currentPricePerKwh: 0.428, // Ø Grundversorgung / Bestandstarif
      switchPricePerKwh: 0.239   // Ø Neukunden- / Wechseltarif
    },
    gas: {
      label: "Gas",
      consumptionByPersons: { 1: 6000, 2: 11000, 3: 15000, 4: 20000, 5: 24000, 6: 29000, 7: 33000 },
      currentPricePerKwh: 0.136,
      switchPricePerKwh: 0.091
    }
  };

  function calculateEnergySavings(inp) {
    const bench = ENERGY_BENCHMARKS[inp.type];
    if (!bench) return { error: "Bitte wählen Sie Strom oder Gas aus." };
    if (!isFinite(inp.consumption) || inp.consumption <= 0) {
      return { error: "Bitte geben Sie einen gültigen Jahresverbrauch an." };
    }

    const avgCurrentAnnual = inp.consumption * bench.currentPricePerKwh;
    const avgSwitchAnnual = inp.consumption * bench.switchPricePerKwh;
    const avgSavings = avgCurrentAnnual - avgSwitchAnnual;

    let actualAnnual = null;
    let actualSavings = null;
    if (isFinite(inp.monthlyPayment) && inp.monthlyPayment > 0) {
      actualAnnual = inp.monthlyPayment * 12;
      actualSavings = actualAnnual - avgSwitchAnnual;
    }

    return {
      label: bench.label, avgCurrentAnnual, avgSwitchAnnual, avgSavings,
      actualAnnual, actualSavings,
      pricePerKwhCurrent: bench.currentPricePerKwh, pricePerKwhSwitch: bench.switchPricePerKwh
    };
  }

  function renderEnergySavingsBarChart(result) {
    const container = document.getElementById("energy-savings-chart");
    if (!container) return;
    clearChildren(container);

    const rows = [
      ["Ø aktueller Tarif (Bestand/Grundversorgung)", result.avgCurrentAnnual, "ice"],
      ["Ø möglicher Wechseltarif", result.avgSwitchAnnual, "ev"]
    ];
    if (result.actualAnnual !== null) {
      rows.unshift(["Ihre eingegebenen Kosten", result.actualAnnual, "ice"]);
    }
    const maxValue = Math.max.apply(null, rows.map(function (r) { return r[1]; }).concat([1]));

    rows.forEach(function (row) {
      const wrap = document.createElement("div");
      wrap.className = "bar-row";
      const labelRow = document.createElement("div");
      labelRow.className = "bar-row-label";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = row[0];
      const valSpan = document.createElement("span");
      valSpan.textContent = formatEuro(row[1]);
      labelRow.appendChild(nameSpan);
      labelRow.appendChild(valSpan);
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill " + row[2];
      fill.style.width = Math.max(0, Math.min(100, (row[1] / maxValue) * 100)) + "%";
      track.appendChild(fill);
      wrap.appendChild(labelRow);
      wrap.appendChild(track);
      container.appendChild(wrap);
    });
  }

  function renderEnergySavings(result) {
    const grid = document.getElementById("energy-savings-grid");
    const disclaimerEl = document.getElementById("energy-savings-disclaimer");
    if (!grid) return;
    clearChildren(grid);

    if (result.error) {
      grid.appendChild(createResultItem("Hinweis", result.error));
      const chart = document.getElementById("energy-savings-chart");
      if (chart) clearChildren(chart);
      if (disclaimerEl) disclaimerEl.textContent = "";
      return;
    }

    grid.appendChild(createResultItem("Ø aktueller Tarif (Bestand/Grundversorgung)", formatEuro(result.avgCurrentAnnual) + " / Jahr"));
    grid.appendChild(createResultItem("Ø möglicher Wechseltarif", formatEuro(result.avgSwitchAnnual) + " / Jahr"));
    grid.appendChild(createResultItem(
      "Geschätzte Ersparnis pro Jahr (Ø-Werte)",
      formatEuro(result.avgSavings),
      result.avgSavings >= 0 ? "positive" : "negative"
    ));
    if (result.actualAnnual !== null) {
      grid.appendChild(createResultItem("Ihre eingegebenen Kosten", formatEuro(result.actualAnnual) + " / Jahr"));
      grid.appendChild(createResultItem(
        "Ihre mögliche Ersparnis",
        formatEuro(result.actualSavings),
        result.actualSavings >= 0 ? "positive" : "negative"
      ));
    }

    renderEnergySavingsBarChart(result);

    if (disclaimerEl) {
      disclaimerEl.textContent = "Grundlage: bundesweite Durchschnittspreise für " + result.label + " von rund " +
        formatNumber(result.pricePerKwhCurrent * 100, 1) + " ct/kWh (Bestand/Grundversorgung) bzw. rund " +
        formatNumber(result.pricePerKwhSwitch * 100, 1) + " ct/kWh (Neukunden-/Wechseltarif). Regional und je nach Anbieter sind erhebliche Abweichungen möglich. Dies ist eine unverbindliche Modellrechnung, keine konkrete Tarifempfehlung.";
    }

    const monthlyEstimate = (result.actualAnnual !== null ? result.actualAnnual : result.avgSwitchAnnual) / 12;
    const personsForStammdaten = parseNumberInput(document.getElementById("t-persons"));
    const stammdatenUpdate = { energyCost: Math.round(monthlyEstimate) };
    if (isFinite(personsForStammdaten)) stammdatenUpdate.householdSize = Math.round(personsForStammdaten);
    saveStammdaten(stammdatenUpdate);
    const energyStammHint = document.getElementById("energy-stammdaten-hint");
    if (energyStammHint) energyStammHint.hidden = false;
  }

  function initEnergySavingsCalculator() {
    const form = document.getElementById("tariff-form");
    const grid = document.getElementById("energy-savings-grid");
    if (!form || !grid) return;

    const typeEl = document.getElementById("t-type");
    const personsEl = document.getElementById("t-persons");
    const consumptionEl = document.getElementById("t-consumption");
    const paymentEl = document.getElementById("t-payment");

    function applyPersonsBenchmark() {
      const bench = ENERGY_BENCHMARKS[typeEl.value];
      if (!bench) return;
      const persons = Math.max(1, Math.min(7, Math.round(parseNumberInput(personsEl))));
      const estimate = bench.consumptionByPersons[persons];
      if (estimate !== undefined) {
        setSliderValue("t-consumption", estimate);
      }
    }

    function run() {
      const result = calculateEnergySavings({
        type: typeEl.value,
        consumption: parseNumberInput(consumptionEl),
        monthlyPayment: parseNumberInput(paymentEl)
      });
      renderEnergySavings(result);
    }

    typeEl.addEventListener("change", function () { applyPersonsBenchmark(); run(); });
    personsEl.addEventListener("input", function () { applyPersonsBenchmark(); run(); });
    consumptionEl.addEventListener("input", run);
    paymentEl.addEventListener("input", run);

    // Haushaltsgröße aus gespeicherten Stammdaten vorschlagen, falls vorhanden.
    if (hasStammdatenValue("householdSize")) {
      setSliderValue("t-persons", getStammdaten().householdSize);
    }

    // Startwert direkt beim Laden auf Basis der Standard-Haushaltsgröße setzen.
    applyPersonsBenchmark();
    run();
  }

  function initTariffForm() {
    const form = document.getElementById("tariff-form");
    if (!form) return;
    const errorEl = document.getElementById("tariff-error");
    const successEl = document.getElementById("tariff-success");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;

      const requiredFields = [
        { id: "t-zip", label: "Postleitzahl" },
        { id: "t-consumption", label: "Jahresverbrauch" },
        { id: "t-firstname", label: "Vorname" },
        { id: "t-lastname", label: "Nachname" },
        { id: "t-email", label: "E-Mail-Adresse" },
        { id: "t-phone", label: "Telefonnummer" }
      ];
      for (const field of requiredFields) {
        const el = document.getElementById(field.id);
        if (!el.value || String(el.value).trim() === "") {
          errorEl.textContent = "Bitte füllen Sie das Pflichtfeld „" + field.label + "“ aus.";
          errorEl.hidden = false;
          el.focus();
          return;
        }
      }
      if (!/^\d{5}$/.test(document.getElementById("t-zip").value.trim())) {
        errorEl.textContent = "Bitte geben Sie eine gültige fünfstellige Postleitzahl ein.";
        errorEl.hidden = false;
        return;
      }
      const email = document.getElementById("t-email").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorEl.textContent = "Bitte geben Sie eine gültige E-Mail-Adresse ein.";
        errorEl.hidden = false;
        return;
      }
      if (!document.getElementById("t-consent").checked) {
        errorEl.textContent = "Bitte bestätigen Sie die Einwilligung zur Weitergabe Ihrer Daten an einen Tarifpartner.";
        errorEl.hidden = false;
        return;
      }

      // TODO FUTURE: fetch(API_ENDPOINTS.tariffLead, ...) über n8n-Webhook,
      // sobald Backend und Einwilligungsprozess vollständig angebunden sind.
      (function () {
        var lines = [];
        form.querySelectorAll("input, select, textarea").forEach(function (el) {
          if (!el.id || el.type === "checkbox" || el.type === "submit" || el.type === "button") return;
          var lab = form.querySelector('label[for="' + el.id + '"]');
          var val = el.tagName === "SELECT" && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : el.value;
          if (val) lines.push((lab ? lab.textContent.trim() : el.id) + ": " + val);
        });
        lines.push("", "Einwilligung zur Weitergabe an einen Tarifpartner: ja");
        window.location.href = "mailto:info@vermieterentlastung.de?subject=" + encodeURIComponent("Strom-/Gasvergleich – Anfrage über Geldhirn") + "&body=" + encodeURIComponent(lines.join("\n"));
      })();
      successEl.textContent = "Ihr E-Mail-Programm wurde mit Ihrer Anfrage geöffnet. Bitte senden Sie die E-Mail ab – wir melden uns kostenlos und unverbindlich bei Ihnen.";
      successEl.hidden = false;
      form.reset();
      form.querySelectorAll('input[type="range"]').forEach(updateSliderDisplay);
      const personsEl = document.getElementById("t-persons");
      if (personsEl) personsEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /* ===================== Versicherungs-Formular (Demo) ===================== */

  function initInsuranceForm() {
    const form = document.getElementById("insurance-form");
    if (!form) return;
    const errorEl = document.getElementById("insurance-error");
    const successEl = document.getElementById("insurance-success");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;

      const requiredFields = [
        { id: "i-zip", label: "Postleitzahl" },
        { id: "i-firstname", label: "Vorname" },
        { id: "i-lastname", label: "Nachname" },
        { id: "i-email", label: "E-Mail-Adresse" },
        { id: "i-phone", label: "Telefonnummer" }
      ];
      for (const field of requiredFields) {
        const el = document.getElementById(field.id);
        if (!el.value || String(el.value).trim() === "") {
          errorEl.textContent = "Bitte füllen Sie das Pflichtfeld „" + field.label + "“ aus.";
          errorEl.hidden = false;
          el.focus();
          return;
        }
      }
      if (!/^\d{5}$/.test(document.getElementById("i-zip").value.trim())) {
        errorEl.textContent = "Bitte geben Sie eine gültige fünfstellige Postleitzahl ein.";
        errorEl.hidden = false;
        return;
      }
      const email = document.getElementById("i-email").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorEl.textContent = "Bitte geben Sie eine gültige E-Mail-Adresse ein.";
        errorEl.hidden = false;
        return;
      }
      const checkedProducts = form.querySelectorAll('input[name="i-product"]:checked');
      if (checkedProducts.length === 0) {
        errorEl.textContent = "Bitte wählen Sie mindestens eine gewünschte Versicherung aus.";
        errorEl.hidden = false;
        return;
      }
      if (!document.getElementById("i-consent").checked) {
        errorEl.textContent = "Bitte bestätigen Sie die Einwilligung zur Weitergabe Ihrer Daten an einen Vermittlungspartner.";
        errorEl.hidden = false;
        return;
      }

      // TODO FUTURE: fetch(API_ENDPOINTS.insuranceLead, ...) über n8n-Webhook.
      successEl.textContent = "Demo-Anfrage erfasst. In der Live-Version würde Ihre Anfrage nach Zustimmung an einen zugelassenen Vermittlungspartner weitergeleitet.";
      successEl.hidden = false;
      form.reset();
    });
  }

  /* ===================== Konto/Login =====================
     Solange config.js nur Platzhalter enthält (isBackendReady() === false),
     verhalten sich alle Formulare unten exakt wie bisher: reine Oberflächen-
     Vorschau, es wird nichts gespeichert oder übertragen.
     Sobald echte Supabase-Zugangsdaten hinterlegt sind, laufen dieselben
     Formulare gegen eine echte Supabase-Anmeldung/-Datenbank. Ein Profilbild
     wird weiterhin sofort lokal per FileReader angezeigt; zusätzlich wird es
     bei konfiguriertem Backend beim Speichern in den Supabase-Storage-Bucket
     "avatars" hochgeladen (siehe SETUP.md). */

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function renderAccountWidget() {
    const link = document.getElementById("account-link");
    if (!link) return;
    if (!isBackendReady()) return; // Standardmarkup ("Anmelden") bleibt unverändert bestehen

    const avatar = link.querySelector(".account-avatar");
    const label = link.querySelector(".account-label");
    const prefix = sitePrefix();

    if (currentUser) {
      link.setAttribute("href", prefix + "konto.html");
      if (label) {
        label.textContent = (currentProfile && currentProfile.username) ||
          (currentUser.email ? currentUser.email.split("@")[0] : "Mein Konto");
      }
      if (avatar) {
        clearChildren(avatar);
        if (currentProfile && currentProfile.avatar_url) {
          const img = document.createElement("img");
          img.src = currentProfile.avatar_url;
          img.alt = "";
          avatar.appendChild(img);
        } else {
          avatar.textContent = "👤";
        }
      }
    } else {
      link.setAttribute("href", prefix + "login.html");
      if (label) label.textContent = "Anmelden";
      if (avatar) { clearChildren(avatar); avatar.textContent = "👤"; }
    }
  }

  function initAuthTabs() {
    const tabLogin = document.getElementById("auth-tab-login");
    const tabRegister = document.getElementById("auth-tab-register");
    const panelLogin = document.getElementById("auth-login-panel");
    const panelRegister = document.getElementById("auth-register-panel");
    if (!tabLogin || !tabRegister || !panelLogin || !panelRegister) return;

    function show(which) {
      const loginActive = which === "login";
      panelLogin.hidden = !loginActive;
      panelRegister.hidden = loginActive;
      tabLogin.setAttribute("aria-selected", String(loginActive));
      tabRegister.setAttribute("aria-selected", String(!loginActive));
      tabLogin.classList.toggle("is-active", loginActive);
      tabRegister.classList.toggle("is-active", !loginActive);
    }

    tabLogin.addEventListener("click", function () { show("login"); });
    tabRegister.addEventListener("click", function () { show("register"); });
  }

  function initLoginForm() {
    const form = document.getElementById("auth-login-form");
    if (!form) return;
    const errorEl = document.getElementById("auth-login-error");
    const successEl = document.getElementById("auth-login-success");
    const submitBtn = form.querySelector('button[type="submit"]');

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;

      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;
      if (!isValidEmail(email)) {
        errorEl.textContent = "Bitte geben Sie eine gültige E-Mail-Adresse ein.";
        errorEl.hidden = false;
        return;
      }
      if (!password) {
        errorEl.textContent = "Bitte geben Sie Ihr Passwort ein.";
        errorEl.hidden = false;
        return;
      }

      if (!isBackendReady()) {
        successEl.textContent = "Demo-Hinweis: Supabase ist noch nicht verbunden (siehe SETUP.md). Es wurde keine echte Anmeldung durchgeführt und nichts gespeichert oder übertragen.";
        successEl.hidden = false;
        form.reset();
        return;
      }

      if (submitBtn) submitBtn.disabled = true;
      supabaseClient.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        if (submitBtn) submitBtn.disabled = false;
        if (res.error) {
          errorEl.textContent = "Anmeldung fehlgeschlagen: " + res.error.message;
          errorEl.hidden = false;
          return;
        }
        successEl.textContent = "Anmeldung erfolgreich. Sie werden weitergeleitet …";
        successEl.hidden = false;
        form.reset();
        setTimeout(function () { window.location.href = sitePrefix() + "konto.html"; }, 600);
      }).catch(function (err) {
        if (submitBtn) submitBtn.disabled = false;
        errorEl.textContent = "Anmeldung fehlgeschlagen: " + (err && err.message ? err.message : "Unbekannter Fehler.");
        errorEl.hidden = false;
      });
    });
  }

  function initRegisterForm() {
    const form = document.getElementById("auth-register-form");
    if (!form) return;
    const errorEl = document.getElementById("auth-register-error");
    const successEl = document.getElementById("auth-register-success");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;

      const requiredFields = [
        { id: "register-firstname", label: "Vorname" },
        { id: "register-lastname", label: "Nachname" },
        { id: "register-email", label: "E-Mail-Adresse" }
      ];
      for (const field of requiredFields) {
        const el = document.getElementById(field.id);
        if (!el.value || String(el.value).trim() === "") {
          errorEl.textContent = "Bitte füllen Sie das Pflichtfeld „" + field.label + "“ aus.";
          errorEl.hidden = false;
          el.focus();
          return;
        }
      }
      if (!isValidEmail(document.getElementById("register-email").value)) {
        errorEl.textContent = "Bitte geben Sie eine gültige E-Mail-Adresse ein.";
        errorEl.hidden = false;
        return;
      }
      const pw1 = document.getElementById("register-password").value;
      const pw2 = document.getElementById("register-password2").value;
      if (!pw1 || pw1.length < 8) {
        errorEl.textContent = "Das Passwort muss mindestens 8 Zeichen lang sein.";
        errorEl.hidden = false;
        return;
      }
      if (pw1 !== pw2) {
        errorEl.textContent = "Die beiden Passwörter stimmen nicht überein.";
        errorEl.hidden = false;
        return;
      }
      if (!document.getElementById("register-consent").checked) {
        errorEl.textContent = "Bitte bestätigen Sie die Zustimmung zu AGB und Datenschutzerklärung.";
        errorEl.hidden = false;
        return;
      }

      if (!isBackendReady()) {
        successEl.textContent = "Demo-Hinweis: Supabase ist noch nicht verbunden (siehe SETUP.md). Es wurde noch kein echtes Konto angelegt. Diese Registrierung ist eine Vorschau der künftigen Funktion.";
        successEl.hidden = false;
        form.reset();
        return;
      }

      const firstname = document.getElementById("register-firstname").value.trim();
      const lastname = document.getElementById("register-lastname").value.trim();
      const email = document.getElementById("register-email").value.trim();
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      supabaseClient.auth.signUp({
        email: email,
        password: pw1,
        options: { data: { first_name: firstname, last_name: lastname } }
      }).then(function (res) {
        if (submitBtn) submitBtn.disabled = false;
        if (res.error) {
          errorEl.textContent = "Registrierung fehlgeschlagen: " + res.error.message;
          errorEl.hidden = false;
          return;
        }

        const user = res.data && res.data.user;
        const session = res.data && res.data.session;

        function afterProfileSaved() {
          form.reset();
          if (session) {
            successEl.textContent = "Konto erstellt und angemeldet. Sie werden weitergeleitet …";
            successEl.hidden = false;
            setTimeout(function () { window.location.href = sitePrefix() + "konto.html"; }, 800);
          } else {
            successEl.textContent = "Konto erstellt. Bitte bestätigen Sie Ihre E-Mail-Adresse über den Link, den wir Ihnen zugeschickt haben, bevor Sie sich anmelden.";
            successEl.hidden = false;
          }
        }

        if (user) {
          supabaseClient.from("profiles").upsert({ id: user.id }).then(afterProfileSaved).catch(afterProfileSaved);
        } else {
          afterProfileSaved();
        }
      }).catch(function (err) {
        if (submitBtn) submitBtn.disabled = false;
        errorEl.textContent = "Registrierung fehlgeschlagen: " + (err && err.message ? err.message : "Unbekannter Fehler.");
        errorEl.hidden = false;
      });
    });
  }

  function initAvatarPreview() {
    const input = document.getElementById("profile-avatar-input");
    const preview = document.getElementById("profile-avatar-preview");
    if (!input || !preview) return;

    input.addEventListener("change", function () {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showModal("Ungültige Datei", "Bitte wählen Sie eine Bilddatei aus.");
        input.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = function (ev) {
        preview.style.backgroundImage = "url(" + ev.target.result + ")";
        preview.textContent = "";
      };
      reader.readAsDataURL(file);
    });
  }

  function initProfileForm() {
    const form = document.getElementById("profile-form");
    if (!form) return;
    const successEl = document.getElementById("profile-success");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      successEl.hidden = true;

      if (!isBackendReady()) {
        successEl.textContent = "Demo-Hinweis: Supabase ist noch nicht verbunden (siehe SETUP.md). Ihr Profilbild und Nutzername wurden nur lokal in dieser Ansicht angezeigt, nicht gespeichert oder hochgeladen.";
        successEl.hidden = false;
        return;
      }
      if (!currentUser) {
        successEl.textContent = "Bitte melden Sie sich zuerst an, um Ihr Profil zu speichern.";
        successEl.hidden = false;
        return;
      }

      const username = document.getElementById("profile-username").value.trim();
      const fileInput = document.getElementById("profile-avatar-input");
      const file = fileInput && fileInput.files && fileInput.files[0];
      const userId = currentUser.id;

      function saveProfile(avatarUrl) {
        const update = { id: userId, username: username || null };
        if (avatarUrl) update.avatar_url = avatarUrl;
        supabaseClient.from("profiles").upsert(update).then(function (res) {
          if (res.error) {
            successEl.textContent = "Profil konnte nicht gespeichert werden: " + res.error.message;
          } else {
            successEl.textContent = "Profil gespeichert.";
            fetchProfile(userId).then(function (profile) { currentProfile = profile; notifyAuthListeners(); });
          }
          successEl.hidden = false;
        });
      }

      if (file) {
        const ext = (file.name.split(".").pop() || "png").toLowerCase();
        const path = userId + "/avatar." + ext;
        supabaseClient.storage.from("avatars").upload(path, file, { upsert: true, contentType: file.type }).then(function (res) {
          if (res.error) {
            successEl.textContent = "Profilbild konnte nicht hochgeladen werden: " + res.error.message;
            successEl.hidden = false;
            return;
          }
          const pub = supabaseClient.storage.from("avatars").getPublicUrl(path);
          saveProfile(pub && pub.data ? pub.data.publicUrl : null);
        });
      } else {
        saveProfile(null);
      }
    });
  }

  function initPersonalDataForm() {
    const form = document.getElementById("personal-data-form");
    if (!form) return;
    const errorEl = document.getElementById("personal-data-error");
    const successEl = document.getElementById("personal-data-success");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      successEl.hidden = true;

      const requiredFields = [
        { id: "pd-firstname", label: "Vorname" },
        { id: "pd-lastname", label: "Nachname" },
        { id: "pd-email", label: "E-Mail-Adresse" }
      ];
      for (const field of requiredFields) {
        const el = document.getElementById(field.id);
        if (!el.value || String(el.value).trim() === "") {
          errorEl.textContent = "Bitte füllen Sie das Pflichtfeld „" + field.label + "“ aus.";
          errorEl.hidden = false;
          el.focus();
          return;
        }
      }
      if (!isValidEmail(document.getElementById("pd-email").value)) {
        errorEl.textContent = "Bitte geben Sie eine gültige E-Mail-Adresse ein.";
        errorEl.hidden = false;
        return;
      }

      if (!isBackendReady()) {
        successEl.textContent = "Demo-Hinweis: Supabase ist noch nicht verbunden (siehe SETUP.md). Ihre Angaben wurden nur in dieser Ansicht verwendet und nicht gespeichert oder übertragen.";
        successEl.hidden = false;
        return;
      }
      if (!currentUser) {
        errorEl.textContent = "Bitte melden Sie sich zuerst an.";
        errorEl.hidden = false;
        return;
      }

      const data = {
        id: currentUser.id,
        first_name: document.getElementById("pd-firstname").value.trim(),
        last_name: document.getElementById("pd-lastname").value.trim(),
        email: document.getElementById("pd-email").value.trim(),
        phone: document.getElementById("pd-phone").value.trim(),
        address: document.getElementById("pd-address").value.trim()
      };

      supabaseClient.from("personal_data").upsert(data).then(function (res) {
        if (res.error) {
          errorEl.textContent = "Speichern fehlgeschlagen: " + res.error.message;
          errorEl.hidden = false;
          return;
        }
        successEl.textContent = "Ihre Angaben wurden gespeichert.";
        successEl.hidden = false;
      });
    });
  }

  function initAccountActionButtons() {
    document.querySelectorAll("[data-account-action]").forEach(function (btn) {
      if (CONFIG.isStripePortalConfigured()) return; // wird von initStripePortalButtons() übernommen
      btn.addEventListener("click", function () {
        showModal(btn.getAttribute("data-account-action"), "Diese Funktion wird verfügbar, sobald die echte Konto- und Zahlungsverwaltung angebunden ist (siehe SETUP.md). Aktuell werden dabei keine Daten gespeichert oder übertragen.");
      });
    });
  }

  /* Aktualisiert Tarif-Anzeige und Upgrade-Button auf konto.html anhand des
     echten Abo-Status, sobald das Backend verbunden ist. Ohne Backend bleibt
     der bisherige, statisch im HTML hinterlegte Vorschau-Text unverändert. */
  function initKontoOverview() {
    const notice = document.getElementById("konto-status-notice");
    const planCard = document.querySelector(".account-plan-card");
    const logoutBtn = document.getElementById("konto-logout-btn");
    if (!notice && !planCard && !logoutBtn) return;

    function render() {
      if (!isBackendReady()) return;

      if (logoutBtn) {
        logoutBtn.hidden = !currentUser;
      }
      if (notice) {
        notice.textContent = currentUser
          ? ("Angemeldet als " + currentUser.email + ". Die folgenden Angaben werden echt in Ihrer Supabase-Datenbank gespeichert.")
          : "Sie sind nicht angemeldet. Bitte melden Sie sich an, um Ihr Konto zu verwalten.";
      }
      if (planCard) {
        const heading = planCard.querySelector("h3");
        const isPro = hasProAccess();
        if (heading) heading.textContent = isPro ? "Pro – aktiv" : "Basic – kostenlos";
        const upgradeBtns = planCard.querySelectorAll("[data-stripe-checkout]");
        upgradeBtns.forEach(function (b) { b.hidden = isPro; });
      }
    }

    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        if (!isBackendReady()) return;
        supabaseClient.auth.signOut().then(function () {
          window.location.href = sitePrefix() + "index.html#start";
        });
      });
    }

    registerAuthListener(render);
    render();
  }

  function initAccountForms() {
    initAuthTabs();
    initLoginForm();
    initRegisterForm();
    initAvatarPreview();
    initProfileForm();
    initPersonalDataForm();
    initAccountActionButtons();
    initStripePortalButtons();
    initStripeCheckoutButtons();
    initKontoOverview();
    registerAuthListener(renderAccountWidget);
    initSupabaseAuthWatcher();
  }

  /* ===================== Footer: Rechtliche Demo-Dialoge ===================== */

  const SUPPORT_EMAIL = "info@vermieterentlastung.de";

  // Echtes Kontaktformular (kein Backend im MVP): baut aus den Eingaben einen
  // mailto:-Link, damit das konkrete Anliegen so genau wie möglich beim Team
  // ankommt, auch wenn "gar nichts mehr geht" (z. B. ein Rechner nicht wie
  // erwartet funktioniert).
  function showContactModal() {
    modalTitle.textContent = "Kontaktformular";
    modalText.innerHTML =
      '<p>Beschreiben Sie Ihr Anliegen so konkret wie möglich – wir öffnen damit eine vorausgefüllte E-Mail an unser Team.</p>' +
      '<form id="contact-form" novalidate>' +
      '<div class="form-field"><label for="contact-name">Name</label><input type="text" id="contact-name" name="contact-name" required></div>' +
      '<div class="form-field"><label for="contact-email">E-Mail-Adresse</label><input type="email" id="contact-email" name="contact-email" required></div>' +
      '<div class="form-field"><label for="contact-topic">Worum geht es?</label>' +
      '<select id="contact-topic" name="contact-topic">' +
      '<option value="Allgemeine Frage">Allgemeine Frage</option>' +
      '<option value="Problem mit einem Rechner">Problem mit einem Rechner</option>' +
      '<option value="Frage zur Pro-Mitgliedschaft">Frage zur Pro-Mitgliedschaft</option>' +
      '<option value="Fehler auf der Seite">Fehler auf der Seite</option>' +
      '<option value="Sonstiges">Sonstiges</option>' +
      '</select></div>' +
      '<div class="form-field"><label for="contact-message">Ihr konkretes Anliegen</label>' +
      '<textarea id="contact-message" name="contact-message" rows="5" required placeholder="Bitte beschreiben Sie so genau wie möglich, worum es geht und was Sie erreichen möchten."></textarea></div>' +
      '<div class="form-actions"><button type="submit" class="btn btn-primary">Per E-Mail senden</button></div>' +
      '<p class="disclaimer">Öffnet Ihr E-Mail-Programm mit einer vorausgefüllten Nachricht an ' + SUPPORT_EMAIL + '. Es wird keine Nachricht automatisch über diese Website verschickt.</p>' +
      '</form>';

    const form = document.getElementById("contact-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        const name = document.getElementById("contact-name").value.trim();
        const email = document.getElementById("contact-email").value.trim();
        const topic = document.getElementById("contact-topic").value;
        const message = document.getElementById("contact-message").value.trim();
        if (!name || !email || !message) return;

        const subject = "Geldhirn Kontakt: " + topic;
        const body =
          "Name: " + name + "\n" +
          "E-Mail: " + email + "\n" +
          "Thema: " + topic + "\n\n" +
          "Anliegen:\n" + message;

        const mailtoUrl =
          "mailto:" + SUPPORT_EMAIL +
          "?subject=" + encodeURIComponent(subject) +
          "&body=" + encodeURIComponent(body);

        window.location.href = mailtoUrl;
        hideModal();
      });
    }

    lastFocusedElement = document.activeElement;
    modalOverlay.hidden = false;
    const firstField = document.getElementById("contact-name");
    if (firstField) firstField.focus();
  }

  function initLegalLinks() {
    document.querySelectorAll("[data-legal]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const kind = btn.getAttribute("data-legal");
        if (kind === "Kontakt") {
          showContactModal();
        } else if (kind === "Service-Bot") {
          showModal(
            "Service-Bot (bald verfügbar)",
            "Hier entsteht ein KI-gestützter Service-Bot, der direkte Fragen zu Rechnern, Ergebnissen und der Pro-Mitgliedschaft beantwortet. Bis dahin erreichen Sie uns über den Menüpunkt „Kontakt“ im Footer – dort können Sie Ihr Anliegen konkret beschreiben."
          );
        } else {
          showModal(kind, "Bitte nutzen Sie Impressum und Datenschutzerklärung im Footer oder schreiben Sie an info@vermieterentlastung.de.");
        }
      });
    });
  }

  /* ======================================================================
     ERGEBNIS TEILEN + PRO-GESAMTBILD-HINWEIS
     Generischer Mechanismus, der bei JEDEM Rechner automatisch sowohl einen
     "Ergebnis teilen"-Button als auch einen kompakten Pro-Hinweis
     ("X von 5 Werten fürs Gesamtbild erfasst") einfügt, sobald dessen
     Ergebnis-Block sichtbar wird. Funktioniert allein über die
     Namenskonvention [id$="-results"] und die einheitliche .result-item-
     Struktur (span = Label, strong = Wert) - keine Änderungen an einzelnen
     Rechnern nötig. Vorher gab es den Pro-Hinweis nur in der statischen
     .pro-connect-box auf den 10 Finanzen-Seiten - das war zu wenig
     sichtbar, u. a. beim Immobilien-Sofortcheck fehlte er komplett.
     ====================================================================== */

  function buildShareSummary(resultsEl) {
    const lines = [];
    resultsEl.querySelectorAll(".result-item").forEach(function (item) {
      const label = item.querySelector("span");
      const value = item.querySelector("strong");
      if (label && value) {
        lines.push(label.textContent.trim() + ": " + value.textContent.trim());
      }
    });
    return lines.join("\n");
  }

  // Ermittelt den relativen Pfad zu finanzen/gesamtplan.html von der
  // aktuellen Seite aus - liest dafür den bereits vorhandenen
  // "Mitgliedschaft"-Link im Hauptmenü aus (a.nav-highlight), statt die
  // Verzeichnistiefe zu erraten.
  function computeGesamtplanHref() {
    if (window.location.pathname.indexOf("/finanzen/") !== -1) {
      return "gesamtplan.html";
    }
    const navHighlight = document.querySelector("a.nav-highlight");
    const navHref = navHighlight ? navHighlight.getAttribute("href") || "" : "";
    const prefix = navHref.replace(/mitgliedschaft\.html.*$/, "");
    return prefix + "finanzen/gesamtplan.html";
  }

  function injectResultActions(resultsEl) {
    if (!resultsEl || resultsEl.querySelector(".result-actions-wrap")) return;

    const wrap = document.createElement("div");
    wrap.className = "result-actions-wrap";

    // Pro-Gesamtbild-Hinweis - ab 2 erfassten Werten wird er deutlich
    // auffälliger ("poppt rein"), weil das Gesamtbild dann schon einen
    // greifbaren Nutzen zeigt statt eine abstrakte Ankündigung zu sein.
    const data = getStammdaten();
    const gp = calculateGesamtplan(data);
    const proHint = document.createElement("p");
    const gesamtplanHref = computeGesamtplanHref();
    const isMilestone = gp.knownCount >= 2;
    proHint.className = "result-pro-hint" + (isMilestone ? " milestone" : "");
    if (isMilestone) {
      const label = gp.knownCount < gp.totalFields ? "Jetzt Gesamtbild ansehen (Pro) →" : "Ihr vollständiges Gesamtbild ansehen (Pro) →";
      proHint.innerHTML = "🎉 Schon " + gp.knownCount + " von " + gp.totalFields + " Werten erfasst! <a href=\"" + gesamtplanHref + "\">" + label + "</a>";
    } else {
      const label = "Gesamtbild vervollständigen (Pro) →";
      proHint.innerHTML = "📊 " + gp.knownCount + " von " + gp.totalFields + " Werten fürs Gesamtbild erfasst – <a href=\"" + gesamtplanHref + "\">" + label + "</a>";
    }
    wrap.appendChild(proHint);

    // Ergebnis teilen
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-outline share-result-btn";
    btn.innerHTML = '<span aria-hidden="true">🔗</span> Ergebnis teilen';
    btn.addEventListener("click", function () {
      const summary = buildShareSummary(resultsEl);
      if (!summary) return;
      const pageTitleEl = document.querySelector("h1");
      let pageTitle = pageTitleEl ? pageTitleEl.textContent.trim() : "Geldhirn-Ergebnis";
      if (resultsEl.dataset.objectName) {
        pageTitle = pageTitle + " – " + resultsEl.dataset.objectName;
      }
      const shareText = pageTitle + "\n\n" + summary + "\n\nBerechnet mit Geldhirn: " + window.location.href;

      if (navigator.share) {
        navigator.share({ title: pageTitle, text: shareText, url: window.location.href }).catch(function () {});
      } else {
        const mailtoUrl =
          "mailto:?subject=" + encodeURIComponent(pageTitle + " – Geldhirn") +
          "&body=" + encodeURIComponent(shareText);
        window.location.href = mailtoUrl;
      }
    });
    wrap.appendChild(btn);

    resultsEl.appendChild(wrap);
  }

  function initShareResultButtons() {
    document.querySelectorAll('[id$="-results"]').forEach(function (resultsEl) {
      if (!resultsEl.hidden) injectResultActions(resultsEl);
      const observer = new MutationObserver(function () {
        if (!resultsEl.hidden) injectResultActions(resultsEl);
      });
      observer.observe(resultsEl, { attributes: true, attributeFilter: ["hidden"] });
    });
  }

  /* ======================================================================
     STAMMDATEN-FORTSCHRITT (Pro-Connect-Box, nur Finanzen-Seiten)
     Reichert zusätzlich jede .pro-connect-box (statische Banner auf den
     Finanzen-Seiten) um denselben Live-Fortschrittsbalken an - eine
     Verstärkung des oben beschriebenen, seitenweiten Hinweises, nicht der
     einzige Ort, an dem er erscheint.
     ====================================================================== */

  function renderStammdatenProgressWidgets() {
    const boxes = document.querySelectorAll(".pro-connect-box");
    if (!boxes.length) return;

    const data = getStammdaten();
    const result = calculateGesamtplan(data);
    const percent = result.totalFields > 0 ? Math.round((result.knownCount / result.totalFields) * 100) : 0;

    boxes.forEach(function (box) {
      if (box.querySelector(".stammdaten-progress")) return;

      const wrap = document.createElement("div");
      wrap.className = "stammdaten-progress";

      const bar = document.createElement("div");
      bar.className = "stammdaten-progress-bar";
      const fill = document.createElement("div");
      fill.className = "stammdaten-progress-fill";
      fill.style.width = percent + "%";
      bar.appendChild(fill);

      const text = document.createElement("p");
      const isMilestone = result.knownCount >= 2;
      text.className = "stammdaten-progress-text" + (isMilestone ? " milestone" : "");
      if (isMilestone) {
        const label = result.knownCount < result.totalFields ? "jetzt Gesamtbild ansehen →" : "vollständiges Gesamtbild ansehen →";
        text.innerHTML = "🎉 Schon " + result.knownCount + " von " + result.totalFields + " Werten erfasst – <a href=\"gesamtplan.html\">" + label + "</a>";
      } else {
        const label = "jetzt vervollständigen →";
        text.innerHTML = result.knownCount + " von " + result.totalFields + " Werten für Ihr Gesamtbild erfasst – <a href=\"gesamtplan.html\">" + label + "</a>";
      }

      wrap.appendChild(bar);
      wrap.appendChild(text);
      box.appendChild(wrap);
    });
  }

  /* ======================================================================
     EMPFEHLUNGSPROGRAMM (Vorbereitung)
     Baut einen teilbaren Link ("index.html?ref=empfehlung") sowie eine
     vorausgefüllte E-Mail zum Weiterempfehlen. Die automatische Gutschrift
     von Pro-Monaten ist noch nicht angebunden (siehe SETUP.md) - hier geht
     es nur um das Teilen selbst, ehrlich als "in Vorbereitung" gekennzeichnet.
     ====================================================================== */

  function buildReferralLink() {
    return window.location.origin + window.location.pathname.replace(/mitgliedschaft\.html$/, "index.html") + "?ref=empfehlung";
  }

  function initReferralWidgets() {
    const copyBtn = document.getElementById("ref-copy-btn");
    const mailBtn = document.getElementById("ref-mail-btn");
    const feedback = document.getElementById("ref-copy-feedback");
    if (!copyBtn && !mailBtn) return;

    function showFeedback(msg) {
      if (!feedback) return;
      feedback.textContent = msg;
      feedback.hidden = false;
    }

    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        const link = buildReferralLink();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(function () {
            showFeedback("Link kopiert: " + link);
          }).catch(function () {
            showFeedback("Kopieren nicht möglich. Ihr Link: " + link);
          });
        } else {
          showFeedback("Ihr Link: " + link);
        }
      });
    }

    if (mailBtn) {
      mailBtn.addEventListener("click", function () {
        const link = buildReferralLink();
        const subject = "Empfehlung: Geldhirn";
        const body =
          "Hallo,\n\nich nutze Geldhirn, um Immobilien-, Energie- und Finanzentscheidungen ehrlich durchzurechnen - kostenlos nutzbar.\n\n" +
          "Schau es dir an: " + link;
        window.location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      });
    }
  }

  /* ======================================================================
     SCHNELLSTART-WEGWEISER (Startseite)
     Kurzer, verzweigter Fragen-Dialog, der Erstbesucher direkt zum
     passenden Rechner führt, statt sie mit 19 Rechnern in 5 Kategorien
     allein zu lassen. Reine Client-Logik, keine Speicherung der Antworten.
     ====================================================================== */

  const QUIZ_STEPS = {
    start: {
      question: "Was ist Ihr Ziel?",
      options: [
        { label: "Immobilie kaufen oder bauen", next: "kaufen" },
        { label: "Zur Miete wohnen", next: "mieten" },
        { label: "Energie sparen", next: "energie" },
        { label: "Finanzen planen", next: "finanzen" }
      ]
    },
    kaufen: {
      question: "Haben Sie schon ein konkretes Objekt im Blick?",
      options: [
        { label: "Ja, ich will es durchrechnen", next: "kaufen_konkret" },
        { label: "Nein, ich suche noch", next: "kaufen_suche" },
        { label: "Ich will erst grob planen, was ich mir leisten kann", href: "finanzen/machbarkeitsrechner.html" }
      ]
    },
    kaufen_konkret: {
      question: "Was möchten Sie zuerst prüfen?",
      options: [
        { label: "Kaufnebenkosten & Finanzierung", href: "immobilien/index.html" },
        { label: "Rendite als Kapitalanlage", href: "immobilien/mietrendite-rechner.html" },
        { label: "Hauskosten im Alltag", href: "immobilien/hauskosten-rechner.html" }
      ]
    },
    kaufen_suche: {
      question: "So geht's weiter",
      options: [
        { label: "Zwei Objekte vergleichen", href: "immobilien/objekt-vergleich.html" },
        { label: "Erst prüfen, was ich mir leisten kann", href: "finanzen/machbarkeitsrechner.html" }
      ]
    },
    mieten: {
      question: "Was passt zu Ihnen?",
      options: [
        { label: "Umzugskosten kalkulieren", href: "immobilien/umzugskosten-rechner.html" },
        { label: "Mieten oder Kaufen vergleichen", href: "immobilien/mieten-oder-kaufen-rechner.html" }
      ]
    },
    energie: {
      question: "Woran denken Sie?",
      options: [
        { label: "Photovoltaik mit Speicher", href: "energie/pv-rechner.html" },
        { label: "Elektroauto", href: "energie/eauto-rechner.html" },
        { label: "Wärmepumpe", href: "energie/waermepumpen-check.html" },
        { label: "Strom- oder Gastarif wechseln", href: "vertraege/strom-gas.html" }
      ]
    },
    finanzen: {
      question: "Was möchten Sie planen?",
      options: [
        { label: "Sparen mit Zinseszins", href: "finanzen/zinseszins-rechner.html" },
        { label: "Meine Rentenlücke", href: "finanzen/rentenluecken-rechner.html" },
        { label: "Sparplan durchrechnen", href: "finanzen/sparplan-rechner.html" }
      ]
    }
  };

  function initQuickStartQuiz() {
    const widget = document.getElementById("quiz-widget");
    if (!widget) return;
    const questionEl = document.getElementById("quiz-question");
    const optionsEl = document.getElementById("quiz-options");
    const backBtn = document.getElementById("quiz-back-btn");
    const history = ["start"];

    function render() {
      const stepKey = history[history.length - 1];
      const step = QUIZ_STEPS[stepKey];
      questionEl.textContent = step.question;
      optionsEl.innerHTML = "";
      step.options.forEach(function (opt) {
        if (opt.href) {
          const a = document.createElement("a");
          a.className = "btn btn-primary quiz-option-btn";
          a.href = opt.href;
          a.textContent = opt.label;
          optionsEl.appendChild(a);
        } else {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-outline quiz-option-btn";
          btn.textContent = opt.label;
          btn.addEventListener("click", function () {
            history.push(opt.next);
            render();
          });
          optionsEl.appendChild(btn);
        }
      });
      backBtn.hidden = history.length <= 1;
    }

    backBtn.addEventListener("click", function () {
      if (history.length > 1) {
        history.pop();
        render();
      }
    });

    render();
  }

  /* ===================== Selbsttests ===================== */

  function runSelfTests() {
    console.group("Geldhirn – Selbsttests");

    function assert(name, condition) {
      if (condition) {
        console.log("%cPASS%c " + name, "color:#1F6F6B;font-weight:bold", "color:inherit");
      } else {
        console.error("FAIL " + name);
      }
    }

    // 1. Immobilienrechnung mit normalen Werten
    const t1 = calculateProperty({
      priceEUR: 380000, areaSqm: 110, yearBuilt: 1998, usage: "kapitalanlage",
      renovationBudget: 15000, ancillaryPercent: 8.5, brokerPercent: 3.57,
      equity: 80000, interestRate: 3.8, repaymentRate: 2, fixedPeriodYears: 15,
      rent: 1150, nonRecoverable: 45, vacancyPercent: 3, maintenancePerSqm: 12,
      propertyTaxYear: 480, buildingInsuranceYear: 420, heatingMonth: 150, otherMonth: 60
    });
    assert("Immobilienrechnung liefert kein Fehlerobjekt", !t1.error);
    assert("Gesamtinvestition ist plausibel positiv", t1.totalInvestment > 380000);
    assert("Restschuld ist keine NaN/Infinity", isFinite(t1.remainingDebt));

    // 2. Darlehen ohne Eigenkapital
    const t2 = calculateProperty({
      priceEUR: 300000, areaSqm: 90, yearBuilt: 2005, usage: "eigennutzung",
      renovationBudget: 0, ancillaryPercent: 8, brokerPercent: 0,
      equity: 0, interestRate: 3.5, repaymentRate: 2, fixedPeriodYears: 10,
      rent: 0, nonRecoverable: 0, vacancyPercent: 0, maintenancePerSqm: 10,
      propertyTaxYear: 400, buildingInsuranceYear: 350, heatingMonth: 120, otherMonth: 40
    });
    assert("Darlehen ohne Eigenkapital entspricht Gesamtinvestition", Math.abs(t2.loanAmount - t2.totalInvestment) < 0.01);
    assert("Monatliche Rate ohne Eigenkapital ist positiv und endlich", isFinite(t2.monthlyRatePayment) && t2.monthlyRatePayment > 0);

    // 3. Kaufpreis 0 muss abgefangen werden
    const t3 = calculateProperty({
      priceEUR: 0, areaSqm: 100, yearBuilt: 2000, usage: "eigennutzung",
      renovationBudget: 0, ancillaryPercent: 8, brokerPercent: 0,
      equity: 0, interestRate: 3, repaymentRate: 2, fixedPeriodYears: 10,
      rent: 0, nonRecoverable: 0, vacancyPercent: 0, maintenancePerSqm: 10,
      propertyTaxYear: 0, buildingInsuranceYear: 0, heatingMonth: 0, otherMonth: 0
    });
    assert("Kaufpreis 0 wird als Fehler erkannt", !!t3.error);

    // 4. E-Auto Ladeanteile ergeben 100 %
    const evBase = {
      annualKm: 14000, holdingYears: 6, priceEV: 42000, priceICE: 34000,
      residualEV: 15000, residualICE: 11000, wallbox: 1500, subsidy: 0,
      evConsumption: 17, homeShare: 60, homePrice: 0.30, publicShare: 25, publicPrice: 0.55,
      pvShare: 15, pvPrice: 0.12, insuranceEV: 750, taxEV: 0, maintenanceEV: 400,
      iceConsumption: 6.5, fuelPrice: 1.75, insuranceICE: 650, taxICE: 180, maintenanceICE: 650
    };
    const t4 = calculateEv(evBase);
    assert("E-Auto-Rechnung mit 100% Ladeanteilen liefert kein Fehlerobjekt", !t4.error);

    // 5. Ladeanteile über 100 % werden abgelehnt
    const evOver = Object.assign({}, evBase, { homeShare: 70 }); // 70+25+15 = 110
    const t5 = calculateEv(evOver);
    assert("Ladeanteile über 100% werden abgelehnt", !!t5.error);

    // 6. E-Auto günstiger als Verbrenner
    const evCheaper = Object.assign({}, evBase, { fuelPrice: 2.2, iceConsumption: 9, maintenanceICE: 1200 });
    const t6 = calculateEv(evCheaper);
    assert("E-Auto günstiger als Verbrenner erkannt", !t6.error && t6.totalDifference > 0);

    // 7. Verbrenner günstiger als E-Auto
    const evExpensive = Object.assign({}, evBase, { priceEV: 70000, wallbox: 3000, subsidy: 0, residualEV: 5000, evConsumption: 25 });
    const t7 = calculateEv(evExpensive);
    assert("Verbrenner günstiger als E-Auto erkannt", !t7.error && t7.totalDifference < 0);

    // 8. Kein Break-even innerhalb kurzer Haltedauer
    const evNoBreakEven = Object.assign({}, evBase, { holdingYears: 1, priceEV: 80000 });
    const t8 = calculateEv(evNoBreakEven);
    assert("Kein Break-even wird sauber erkannt (kein NaN/Infinity)", !t8.error && (t8.breakEvenReached === false || t8.breakEvenYears === null) && (t8.breakEvenYears === null || isFinite(t8.breakEvenYears)));

    // 9. Haltedauer 0 wird abgelehnt
    const evZeroYears = Object.assign({}, evBase, { holdingYears: 0 });
    const t9 = calculateEv(evZeroYears);
    assert("Haltedauer 0 wird als Fehler erkannt", !!t9.error);

    // 10. PV-Rechner: Normalfall mit Speicher liefert kein Fehlerobjekt (automatischer Ertrag + Eigenverbrauch)
    const pvBase = {
      consumption: 4500, kwp: 8, zip: "98574", investment: 14000, maintenance: 150,
      batterySize: 7, batteryInvestment: 6000, price: 0.35, feedIn: 0.08, years: 20
    };
    const t10 = calculatePv(pvBase);
    assert("PV-Rechnung mit Speicher liefert kein Fehlerobjekt", !t10.error);
    assert("PV: Speicher-Szenario vorhanden", !!t10.withBattery);
    assert("PV: Autarkiegrad mit Speicher ist keine NaN/Infinity", isFinite(t10.withBattery.selfSufficiencyPercent));
    assert("PV: spezifischer Ertrag wird automatisch aus PLZ geschätzt (kein Fallback-Durchschnitt)", t10.specificYield !== DEFAULT_PV_YIELD || PV_YIELD_BY_ZIP_PREFIX["9"] === DEFAULT_PV_YIELD);
    assert("PV: Eigenverbrauch mit Speicher automatisch höher geschätzt als ohne Speicher", t10.selfUsePercentWithBattery > t10.selfUsePercentWithoutBattery);

    // 11. PV-Rechner ohne Speicher (Speichergröße 0) und ohne Postleitzahl (Fallback-Durchschnitt)
    const pvNoBattery = Object.assign({}, pvBase, { batterySize: 0, zip: "" });
    const t11 = calculatePv(pvNoBattery);
    assert("PV ohne Speicher liefert kein withBattery-Objekt", !t11.error && t11.withBattery === null);
    assert("PV ohne PLZ verwendet bundesweiten Durchschnittsertrag", t11.specificYield === DEFAULT_PV_YIELD);

    // 12. PV-Rechner: kWp 0 wird abgefangen
    const pvZeroKwp = Object.assign({}, pvBase, { kwp: 0 });
    const t12 = calculatePv(pvZeroKwp);
    assert("PV: kWp 0 wird als Fehler erkannt", !!t12.error);

    // 13. Zinseszinsrechner: Normalfall mit Zins und Sparrate
    const t13 = calculateCompoundInterest({ startCapital: 10000, monthlyRate: 200, annualInterest: 5, years: 20 });
    assert("Zinseszins liefert kein Fehlerobjekt", !t13.error);
    assert("Zinseszins: Endkapital größer als eingezahltes Kapital bei positivem Zins", t13.finalCapital > t13.totalContributions);
    assert("Zinseszins: keine NaN/Infinity", isFinite(t13.finalCapital) && isFinite(t13.totalInterest));

    // 14. Zinseszinsrechner: 0 % Zins bleibt linear und fehlerfrei
    const t14 = calculateCompoundInterest({ startCapital: 5000, monthlyRate: 100, annualInterest: 0, years: 10 });
    assert("Zinseszins bei 0% Zins entspricht Summe der Einzahlungen", Math.abs(t14.finalCapital - (5000 + 100 * 120)) < 0.01);

    // 15. Zinseszinsrechner: negative Laufzeit wird abgelehnt
    const t15 = calculateCompoundInterest({ startCapital: 1000, monthlyRate: 50, annualInterest: 3, years: 0 });
    assert("Zinseszins: Laufzeit 0 wird als Fehler erkannt", !!t15.error);

    // 16. Entnahmeplan: hohe Entnahme führt zu Kapitalverzehr innerhalb des Zeitraums
    const t16 = calculateWithdrawalPlan({ startCapital: 100000, annualReturn: 2, monthlyWithdrawal: 3000, inflationRate: 2, maxYears: 40 });
    assert("Entnahmeplan (hohe Entnahme) liefert kein Fehlerobjekt", !t16.error);
    assert("Entnahmeplan (hohe Entnahme): Kapital wird aufgebraucht", t16.depleted === true);
    assert("Entnahmeplan (hohe Entnahme): Monate sind endliche Zahl", isFinite(t16.months) && t16.months > 0);

    // 17. Entnahmeplan: niedrige Entnahme reicht über den Betrachtungszeitraum hinaus
    const t17 = calculateWithdrawalPlan({ startCapital: 500000, annualReturn: 5, monthlyWithdrawal: 500, inflationRate: 1, maxYears: 30 });
    assert("Entnahmeplan (niedrige Entnahme) liefert kein Fehlerobjekt", !t17.error);
    assert("Entnahmeplan (niedrige Entnahme): Kapital reicht über Betrachtungszeitraum hinaus", t17.depleted === false);
    assert("Entnahmeplan (niedrige Entnahme): Restkapital keine NaN/Infinity", isFinite(t17.remainingCapital));

    // 18. Entnahmeplan: Startkapital 0 wird abgefangen
    const t18 = calculateWithdrawalPlan({ startCapital: 0, annualReturn: 3, monthlyWithdrawal: 500, inflationRate: 2, maxYears: 20 });
    assert("Entnahmeplan: Startkapital 0 wird als Fehler erkannt", !!t18.error);

    // 19. Strom-/Gas-Sparrechner: Normalfall Strom liefert plausible Ersparnis
    const t19 = calculateEnergySavings({ type: "strom", consumption: 3500, monthlyPayment: 0 });
    assert("Energiesparrechner (Strom) liefert kein Fehlerobjekt", !t19.error);
    assert("Energiesparrechner: Ø-Ersparnis ist positiv (Wechseltarif günstiger)", t19.avgSavings > 0);
    assert("Energiesparrechner: keine NaN/Infinity", isFinite(t19.avgCurrentAnnual) && isFinite(t19.avgSwitchAnnual));

    // 20. Strom-/Gas-Sparrechner: eigene Kosten werden berücksichtigt
    const t20 = calculateEnergySavings({ type: "gas", consumption: 15000, monthlyPayment: 150 });
    assert("Energiesparrechner: eigene Kosten liefern actualAnnual", t20.actualAnnual === 150 * 12);
    assert("Energiesparrechner: eigene Ersparnis berechnet", isFinite(t20.actualSavings));

    // 21. Strom-/Gas-Sparrechner: ungültiger Verbrauch wird abgefangen
    const t21 = calculateEnergySavings({ type: "strom", consumption: 0, monthlyPayment: 0 });
    assert("Energiesparrechner: Verbrauch 0 wird als Fehler erkannt", !!t21.error);

    // 22. Wärmepumpen-Check: gut sanierter Neubau mit Fußbodenheizung ist gut geeignet
    const t22 = calculateHeatPump({ area: 140, heatDemand: 12000, heatingCost: 1400, price: 0.30, insulation: "neubau", emitter: "fussboden" });
    assert("Wärmepumpen-Check liefert kein Fehlerobjekt", !t22.error);
    assert("Wärmepumpen-Check: gute Voraussetzungen ergeben grünen Status", t22.status === "green");
    assert("Wärmepumpen-Check: JAZ ist endliche Zahl", isFinite(t22.jaz));

    // 23. Wärmepumpen-Check: unsanierter Altbau mit alten Heizkörpern ist ungünstig
    const t23 = calculateHeatPump({ area: 140, heatDemand: 25000, heatingCost: 3000, price: 0.30, insulation: "unsaniert", emitter: "hochtemperatur" });
    assert("Wärmepumpen-Check: schlechte Voraussetzungen ergeben roten Status", t23.status === "red");

    // 24. Wärmepumpen-Check: Fläche 0 wird abgefangen
    const t24 = calculateHeatPump({ area: 0, heatDemand: 12000, heatingCost: 1400, price: 0.30, insulation: "neubau", emitter: "fussboden" });
    assert("Wärmepumpen-Check: Fläche 0 wird als Fehler erkannt", !!t24.error);

    // 25. Sanierungskostenrechner: einzelne Maßnahme
    const t25 = calculateRenovation({ area: 140, roof: true, facade: false, windows: false, heating: false, subsidyPercent: 20 });
    assert("Sanierungskostenrechner liefert kein Fehlerobjekt", !t25.error);
    assert("Sanierungskostenrechner: Nettokosten kleiner als Gesamtkosten bei Förderung", t25.netCost < t25.total);

    // 26. Sanierungskostenrechner: keine Maßnahme ausgewählt wird abgefangen
    const t26 = calculateRenovation({ area: 140, roof: false, facade: false, windows: false, heating: false, subsidyPercent: 0 });
    assert("Sanierungskostenrechner: keine Maßnahme wird als Fehler erkannt", !!t26.error);

    // 27. Mietrenditerechner: Normalfall
    const t27 = calculateRentalYield({ price: 300000, buyingCostsPercent: 10, annualRent: 15000, operatingCostsPercent: 20, equity: 60000, interestRate: 3.8 });
    assert("Mietrenditerechner liefert kein Fehlerobjekt", !t27.error);
    assert("Mietrenditerechner: Nettorendite kleiner als Bruttorendite", t27.netYield < t27.grossYield);
    assert("Mietrenditerechner: keine NaN/Infinity", isFinite(t27.netYield) && isFinite(t27.cashFlowBeforeTax));

    // 28. Mietrenditerechner: Kaufpreis 0 wird abgefangen
    const t28 = calculateRentalYield({ price: 0, buyingCostsPercent: 10, annualRent: 15000, operatingCostsPercent: 20, equity: 60000, interestRate: 3.8 });
    assert("Mietrenditerechner: Kaufpreis 0 wird als Fehler erkannt", !!t28.error);

    // 29. Mieten-oder-Kaufen-Rechner: Normalfall liefert kein Fehlerobjekt und plausible Werte
    const t29 = calculateRentVsBuy({
      price: 380000, buyingCostsPercent: 10, equity: 80000, interestRate: 3.8, repaymentPercent: 2,
      maintenanceReserve: 150, comparableRent: 1300, rentIncrease: 2, appreciationRate: 1.5, opportunityRate: 4, years: 15
    });
    assert("Mieten-oder-Kaufen-Rechner liefert kein Fehlerobjekt", !t29.error);
    assert("Mieten-oder-Kaufen-Rechner: Restschuld am Ende keine NaN/Infinity", isFinite(t29.remainingDebtEnd));
    assert("Mieten-oder-Kaufen-Rechner: Vermögensvorteil keine NaN/Infinity", isFinite(t29.advantage));

    // 30. Mieten-oder-Kaufen-Rechner: Betrachtungszeitraum 0 wird abgefangen
    const t30 = calculateRentVsBuy({
      price: 380000, buyingCostsPercent: 10, equity: 80000, interestRate: 3.8, repaymentPercent: 2,
      maintenanceReserve: 150, comparableRent: 1300, rentIncrease: 2, appreciationRate: 1.5, opportunityRate: 4, years: 0
    });
    assert("Mieten-oder-Kaufen-Rechner: Betrachtungszeitraum 0 wird als Fehler erkannt", !!t30.error);

    // 31. Hauskostenrechner: Normalfall summiert korrekt
    const t31 = calculateHouseCosts({ area: 140, propertyTax: 450, buildingInsurance: 400, heating: 1800, electricity: 1500, water: 500, waste: 250, maintenance: 1800, other: 0 });
    assert("Hauskostenrechner liefert kein Fehlerobjekt", !t31.error);
    assert("Hauskostenrechner: Summe stimmt", Math.abs(t31.total - 6700) < 0.01);
    assert("Hauskostenrechner: Kosten pro m² und Monat sind endlich", isFinite(t31.perSqmMonth));

    // 32. Hauskostenrechner: Fläche 0 wird abgefangen
    const t32 = calculateHouseCosts({ area: 0, propertyTax: 0, buildingInsurance: 0, heating: 0, electricity: 0, water: 0, waste: 0, maintenance: 0, other: 0 });
    assert("Hauskostenrechner: Fläche 0 wird als Fehler erkannt", !!t32.error);

    // 33. Versicherungs-Kostenorientierung: Beitrag im üblichen Rahmen
    const t33 = calculateInsuranceCheck({ type: "haftpflicht", area: 0, currentAmount: 60 });
    assert("Versicherungs-Kostenorientierung liefert kein Fehlerobjekt", !t33.error);
    assert("Versicherungs-Kostenorientierung: Beitrag im Rahmen ergibt grünen Status", t33.status === "green");

    // 34. Versicherungs-Kostenorientierung: Beitrag deutlich über dem Rahmen
    const t34 = calculateInsuranceCheck({ type: "wohngebaeude", area: 120, currentAmount: 2000 });
    assert("Versicherungs-Kostenorientierung: hoher Beitrag ergibt roten Status", t34.status === "red");

    // 35. Versicherungs-Kostenorientierung: unbekannte Art wird abgefangen
    const t35 = calculateInsuranceCheck({ type: "unbekannt", area: 0, currentAmount: 60 });
    assert("Versicherungs-Kostenorientierung: unbekannte Art wird als Fehler erkannt", !!t35.error);

    // 36. Sparplanrechner: Normalfall mit Rendite
    const t36 = calculateSavingsPlan({ monthlyRate: 200, startCapital: 2000, years: 20, annualReturn: 5, dynamicPercent: 0 });
    assert("Sparplanrechner liefert kein Fehlerobjekt", !t36.error);
    assert("Sparplanrechner: Endkapital größer als eingezahltes Kapital", t36.endCapital > t36.totalContributions);

    // 37. Sparplanrechner: 0% Rendite entspricht Summe der Einzahlungen
    const t37 = calculateSavingsPlan({ monthlyRate: 100, startCapital: 1000, years: 5, annualReturn: 0, dynamicPercent: 0 });
    assert("Sparplanrechner bei 0% Rendite entspricht Summe der Einzahlungen", Math.abs(t37.endCapital - (1000 + 100 * 60)) < 0.01);

    // 38. Sparplanrechner: Laufzeit 0 wird abgefangen
    const t38 = calculateSavingsPlan({ monthlyRate: 100, startCapital: 1000, years: 0, annualReturn: 5, dynamicPercent: 0 });
    assert("Sparplanrechner: Laufzeit 0 wird als Fehler erkannt", !!t38.error);

    // 39. Rentenlückenrechner: Lücke wird korrekt berechnet
    const t39 = calculatePensionGap({ netIncome: 2500, targetPercent: 80, statePension: 1400, yearsToRetirement: 25, payoutYears: 20, existingCapital: 15000, expectedReturn: 4 });
    assert("Rentenlückenrechner liefert kein Fehlerobjekt", !t39.error);
    assert("Rentenlückenrechner: monatliche Lücke stimmt", Math.abs(t39.monthlyGap - (2500 * 0.8 - 1400)) < 0.01);
    assert("Rentenlückenrechner: erforderliche Sparrate ist endliche Zahl", isFinite(t39.requiredMonthlySavings));

    // 40. Rentenlückenrechner: Nettoeinkommen 0 wird abgefangen
    const t40 = calculatePensionGap({ netIncome: 0, targetPercent: 80, statePension: 1400, yearsToRetirement: 25, payoutYears: 20, existingCapital: 0, expectedReturn: 4 });
    assert("Rentenlückenrechner: Nettoeinkommen 0 wird als Fehler erkannt", !!t40.error);

    // 41. Kreditvergleichsrechner: günstigeres Angebot wird erkannt
    const t41 = calculateLoanComparison({ amount: 20000, months: 60, rateA: 5.5, feeA: 0, rateB: 4.9, feeB: 200 });
    assert("Kreditvergleichsrechner liefert kein Fehlerobjekt", !t41.error);
    assert("Kreditvergleichsrechner: günstigeres Angebot B erkannt", t41.cheaper === "B");
    assert("Kreditvergleichsrechner: monatliche Raten sind endliche Zahlen", isFinite(t41.offerA.monthlyPayment) && isFinite(t41.offerB.monthlyPayment));

    // 42. Kreditvergleichsrechner: Kreditsumme 0 wird abgefangen
    const t42 = calculateLoanComparison({ amount: 0, months: 60, rateA: 5, feeA: 0, rateB: 5, feeB: 0 });
    assert("Kreditvergleichsrechner: Kreditsumme 0 wird als Fehler erkannt", !!t42.error);

    // 43. Inflationsrechner: Kaufkraftverlust ist plausibel
    const t43 = calculateInflation({ amount: 10000, years: 10, rate: 2 });
    assert("Inflationsrechner liefert kein Fehlerobjekt", !t43.error);
    assert("Inflationsrechner: nötiger Betrag in Zukunft größer als heutiger Betrag", t43.futureAmountNeeded > 10000);
    assert("Inflationsrechner: Kaufkraftverlust liegt zwischen 0 und 100%", t43.purchasingPowerLossPercent > 0 && t43.purchasingPowerLossPercent < 100);

    // 44. Inflationsrechner: 0% Inflation bedeutet keinen Kaufkraftverlust
    const t44 = calculateInflation({ amount: 10000, years: 10, rate: 0 });
    assert("Inflationsrechner bei 0% Inflation: kein Kaufkraftverlust", Math.abs(t44.purchasingPowerLossPercent) < 0.001);

    // 45. Inflationsrechner: Betrag 0 wird abgefangen
    const t45 = calculateInflation({ amount: 0, years: 10, rate: 2 });
    assert("Inflationsrechner: Betrag 0 wird als Fehler erkannt", !!t45.error);

    // 46. Umzugskostenrechner: Normalfall (Halbservice) liefert kein Fehlerobjekt
    const t46 = calculateMovingCosts({
      rooms: 3, distance: 40, service: "halb", rent: 900, doubleMonths: 1,
      renovation: true, parking: true, assembly: false
    });
    assert("Umzugskostenrechner liefert kein Fehlerobjekt", !t46.error);
    assert("Umzugskostenrechner: Gesamtkosten sind endliche, positive Zahl", isFinite(t46.total) && t46.total > 0);
    assert("Umzugskostenrechner: Basisposten plus alle Zusatzposten (Reno, Parkverbot, doppelte Miete) enthalten", t46.items.length === 4);

    // 47. Umzugskostenrechner: Zimmeranzahl 0 wird abgefangen
    const t47 = calculateMovingCosts({ rooms: 0, distance: 40, service: "selbst", rent: 0, doubleMonths: 0, renovation: false, parking: false, assembly: false });
    assert("Umzugskostenrechner: Zimmeranzahl 0 wird als Fehler erkannt", !!t47.error);

    // 48. Objekt-Vergleichsrechner: Normalfall erkennt günstigeres/renditestärkeres Objekt korrekt
    const t48 = calculateObjectCompare({
      aPrice: 300000, aArea: 100, aRent: 900,
      bPrice: 250000, bArea: 90, bRent: 850
    });
    assert("Objekt-Vergleichsrechner liefert kein Fehlerobjekt", !t48.error);
    assert("Objekt-Vergleichsrechner: Preis pro m² für A und B endlich", isFinite(t48.a.pricePerSqm) && isFinite(t48.b.pricePerSqm));
    assert("Objekt-Vergleichsrechner: günstigeres Objekt pro m² korrekt erkannt (B)", t48.cheaperPerSqm === "B");
    assert("Objekt-Vergleichsrechner: höhere Bruttorendite korrekt erkannt (B)", t48.higherYield === "B");

    // 49. Objekt-Vergleichsrechner: Kaufpreis 0 bei Objekt A wird abgefangen
    const t49 = calculateObjectCompare({ aPrice: 0, aArea: 100, aRent: 900, bPrice: 250000, bArea: 90, bRent: 850 });
    assert("Objekt-Vergleichsrechner: Kaufpreis 0 wird als Fehler erkannt", !!t49.error);

    // 50. Brutto-Netto-Rechner: Normalfall liefert plausibles Nettogehalt
    const t50 = calculateGrossNet({ grossMonthly: 4000, taxClass: "1", churchRate: 0, childless: false });
    assert("Brutto-Netto: liefert kein Fehlerobjekt", !t50.error);
    assert("Brutto-Netto: Nettogehalt liegt zwischen 0 und Bruttogehalt", t50.netMonthly > 0 && t50.netMonthly < t50.grossMonthly);
    assert("Brutto-Netto: Sozialabgaben und Steuern sind endliche, nicht-negative Zahlen", isFinite(t50.totalSV) && t50.totalSV >= 0 && isFinite(t50.totalTaxes) && t50.totalTaxes >= 0);

    // 51. Brutto-Netto-Rechner: Bruttogehalt 0 wird als Fehler erkannt
    const t51 = calculateGrossNet({ grossMonthly: 0, taxClass: "1", churchRate: 0, childless: false });
    assert("Brutto-Netto: Bruttogehalt 0 wird als Fehler erkannt", !!t51.error);

    // 52. Brutto-Netto-Rechner: Steuerklasse III (Splitting) führt bei gleichem Brutto zu höherem Netto als Steuerklasse VI (ohne Freibeträge)
    const t52a = calculateGrossNet({ grossMonthly: 4500, taxClass: "3", churchRate: 0, childless: false });
    const t52b = calculateGrossNet({ grossMonthly: 4500, taxClass: "6", churchRate: 0, childless: false });
    assert("Brutto-Netto: Steuerklasse III führt zu höherem Netto als Steuerklasse VI bei gleichem Brutto", t52a.netMonthly > t52b.netMonthly);

    // 53. Machbarkeitsrechner: Überschuss und Sparpuffer werden korrekt berechnet
    const t53 = calculateFeasibility({ netIncome: 3000, housing: 900, insurance: 150, energy: 180, otherFixed: 250, living: 600 });
    assert("Machbarkeitsrechner liefert kein Fehlerobjekt", !t53.error);
    assert("Machbarkeitsrechner: Überschuss korrekt berechnet", Math.abs(t53.surplus - (3000 - (900 + 150 + 180 + 250 + 600))) < 0.01);
    assert("Machbarkeitsrechner: Sparpuffer entspricht 3 Monatsausgaben", Math.abs(t53.recommendedBuffer - t53.totalExpenses * 3) < 0.01);

    // 54. Machbarkeitsrechner: negativer Wert wird als Fehler erkannt
    const t54 = calculateFeasibility({ netIncome: 3000, housing: -100, insurance: 150, energy: 180, otherFixed: 250, living: 600 });
    assert("Machbarkeitsrechner: negativer Wert wird als Fehler erkannt", !!t54.error);

    // 55. Machbarkeitsrechner: Vermögensentwicklung (ETF-Sparplan) liefert plausible Meilensteine
    const t55 = calculateFeasibilityWealth({ monthlyRate: 300, annualReturn: 7, years: 20 });
    assert("Vermögensentwicklung liefert kein Fehlerobjekt", !t55.error);
    assert("Vermögensentwicklung: mindestens ein Meilenstein vorhanden", t55.milestones.length > 0);
    assert("Vermögensentwicklung: Endkapital größer als eingezahltes Kapital bei positiver Rendite", t55.final.finalCapital > t55.final.totalContributions);

    // 56. Vermögensentwicklung: negative Sparrate wird als Fehler erkannt
    const t56 = calculateFeasibilityWealth({ monthlyRate: -50, annualReturn: 7, years: 20 });
    assert("Vermögensentwicklung: negative Sparrate wird als Fehler erkannt", !!t56.error);

    // 57. Stammdaten: mergeStammdatenData fuehrt Daten korrekt zusammen (reine Funktion, kein I/O)
    const t57 = mergeStammdatenData({ netIncome: 2000, housing: 800 }, { housing: 950, energy: 120 });
    assert("Stammdaten-Merge behaelt unveraenderte Felder", t57.netIncome === 2000);
    assert("Stammdaten-Merge ueberschreibt vorhandene Felder", t57.housing === 950);
    assert("Stammdaten-Merge ergaenzt neue Felder", t57.energy === 120);

    // 58. Stammdaten: mergeStammdatenData ignoriert ungueltige Werte (undefined/NaN/null)
    const t58 = mergeStammdatenData({ netIncome: 2000 }, { netIncome: undefined, housing: NaN, insurance: null });
    assert("Stammdaten-Merge ignoriert undefined", t58.netIncome === 2000);
    assert("Stammdaten-Merge ignoriert NaN", !("housing" in t58));
    assert("Stammdaten-Merge ignoriert null", !("insurance" in t58));

    // 59. Stammdaten: mergeStammdatenData funktioniert auch ohne bestehende Daten
    const t59 = mergeStammdatenData(null, { netIncome: 1500 });
    assert("Stammdaten-Merge funktioniert ohne bestehende Daten", t59.netIncome === 1500);

    // 60. Lebensmittelkosten-Schaetzung: plausible Werte je Personenzahl (reine Funktion, kein I/O)
    assert("Lebensmittelkosten 1 Person = 250 €", suggestGroceryCost(1) === 250);
    assert("Lebensmittelkosten 2 Personen = 430 €", suggestGroceryCost(2) === 430);
    assert("Lebensmittelkosten 4 Personen = 790 €", suggestGroceryCost(4) === 790);
    assert("Lebensmittelkosten steigen mit Personenzahl", suggestGroceryCost(5) > suggestGroceryCost(2));

    // 61. Lebensmittelkosten-Schaetzung: Grenzwerte werden abgefangen
    assert("Lebensmittelkosten bei 0 Personen = Wert fuer 1 Person", suggestGroceryCost(0) === suggestGroceryCost(1));
    assert("Lebensmittelkosten bei 20 Personen = Wert fuer 8 Personen (Obergrenze)", suggestGroceryCost(20) === suggestGroceryCost(8));

    // 62. Gesamtplanrechner: calculateGesamtplan summiert bekannte Werte korrekt (reine Funktion, kein I/O)
    const t62 = calculateGesamtplan({ netIncome: 2500, housingCost: 900, energyCost: 150, pvMonthlyBenefit: 80, evMonthlySavings: 60 });
    assert("Gesamtplan: Saldo = Einkommen + PV + E-Auto - Wohnen - Energie", Math.abs(t62.total - (2500 + 80 + 60 - 900 - 150)) < 0.01);
    assert("Gesamtplan: alle 5 Felder als bekannt gezaehlt", t62.knownCount === 5 && t62.totalFields === 5);

    // 63. Gesamtplanrechner: unbekannte/ungueltige Felder werden ausgelassen
    const t63 = calculateGesamtplan({ netIncome: 2000, pvMonthlyBenefit: NaN });
    assert("Gesamtplan: nur gueltige numerische Felder werden gezaehlt", t63.knownCount === 1);
    assert("Gesamtplan: Saldo entspricht dann nur dem bekannten Feld", t63.total === 2000);

    // 64. Gesamtplanrechner: leere/keine Daten ergeben Saldo 0 und knownCount 0
    const t64 = calculateGesamtplan({});
    assert("Gesamtplan: keine Daten -> Saldo 0", t64.total === 0);
    assert("Gesamtplan: keine Daten -> knownCount 0", t64.knownCount === 0);
    const t64b = calculateGesamtplan(null);
    assert("Gesamtplan: null-Eingabe wird sicher abgefangen", t64b.total === 0 && t64b.knownCount === 0);

    // 65. Umsatzsteuerrechner: Netto -> Brutto bei 19%
    const t65 = calculateVat({ amount: 100, rate: 19, direction: "netto" });
    assert("Umsatzsteuer netto->brutto liefert kein Fehlerobjekt", !t65.error);
    assert("Umsatzsteuer netto->brutto: Brutto korrekt", Math.abs(t65.gross - 119) < 0.01);
    assert("Umsatzsteuer netto->brutto: Steuerbetrag korrekt", Math.abs(t65.vat - 19) < 0.01);

    // 66. Umsatzsteuerrechner: Brutto -> Netto bei 19% (Umkehrung von Test 65)
    const t66 = calculateVat({ amount: 119, rate: 19, direction: "brutto" });
    assert("Umsatzsteuer brutto->netto liefert kein Fehlerobjekt", !t66.error);
    assert("Umsatzsteuer brutto->netto: Netto korrekt", Math.abs(t66.net - 100) < 0.01);
    assert("Umsatzsteuer brutto->netto: Steuerbetrag korrekt", Math.abs(t66.vat - 19) < 0.01);

    // 67. Umsatzsteuerrechner: Betrag 0 wird abgefangen
    const t67 = calculateVat({ amount: 0, rate: 19, direction: "netto" });
    assert("Umsatzsteuer: Betrag 0 wird als Fehler erkannt", !!t67.error);

    // 68. Benzinkostenrechner: Normalfall liefert plausible, konsistente Werte
    const t68 = calculateFuelCost({ kmPerYear: 15000, consumption: 7, pricePerLiter: 1.75 });
    assert("Benzinkosten liefert kein Fehlerobjekt", !t68.error);
    assert("Benzinkosten: Liter pro Jahr korrekt", Math.abs(t68.litersPerYear - 1050) < 0.01);
    assert("Benzinkosten: Kosten pro Jahr korrekt", Math.abs(t68.costPerYear - 1837.5) < 0.01);
    assert("Benzinkosten: Kosten pro Monat = Kosten pro Jahr / 12", Math.abs(t68.costPerMonth - t68.costPerYear / 12) < 0.01);

    // 69. Benzinkostenrechner: Verbrauch 0 wird abgefangen
    const t69 = calculateFuelCost({ kmPerYear: 15000, consumption: 0, pricePerLiter: 1.75 });
    assert("Benzinkosten: Verbrauch 0 wird als Fehler erkannt", !!t69.error);

    // 70. Baufinanzierungsrechner: Normalfall liefert plausible Werte, nutzt bestehende Restschuld-Funktion
    const t70 = calculateMortgage({ loanAmount: 300000, interestRate: 3.5, repaymentRate: 2, fixedYears: 10 });
    assert("Baufinanzierung liefert kein Fehlerobjekt", !t70.error);
    assert("Baufinanzierung: monatliche Rate korrekt (Zins+Tilgung)", Math.abs(t70.monthlyPayment - 1375) < 0.01);
    assert("Baufinanzierung: Restschuld liegt zwischen 0 und Darlehenssumme", t70.remainingDebt > 0 && t70.remainingDebt < 300000);
    assert("Baufinanzierung: getilgter Betrag + Restschuld = Darlehenssumme", Math.abs((300000 - t70.remainingDebt) + t70.remainingDebt - 300000) < 0.01);
    assert("Baufinanzierung: gezahlte Zinsen + Tilgung = Gesamtzahlung", Math.abs(t70.interestPaid + t70.principalPaid - t70.totalPaid) < 0.01);

    // 71. Baufinanzierungsrechner: Darlehenssumme 0 wird abgefangen
    const t71 = calculateMortgage({ loanAmount: 0, interestRate: 3.5, repaymentRate: 2, fixedYears: 10 });
    assert("Baufinanzierung: Darlehenssumme 0 wird als Fehler erkannt", !!t71.error);

    // 72. Auto-Leasing-/Finanzierungsrechner: Normalfall liefert plausible, konsistente Werte
    const t72 = calculateCarFinancing({ price: 30000, downPayment: 3000, months: 36, leasingRate: 350, interestRate: 4, residualValue: 15000 });
    assert("Auto-Leasing/Finanzierung liefert kein Fehlerobjekt", !t72.error);
    assert("Auto-Leasing/Finanzierung: Leasing-Gesamtkosten korrekt", Math.abs(t72.leasingTotalCost - 15600) < 0.01);
    assert("Auto-Leasing/Finanzierung: Finanzierungsrate ist plausible positive Zahl", t72.financeMonthlyPayment > 0);
    assert("Auto-Leasing/Finanzierung: Vorteil = Leasing-Gesamtkosten - Finanzierung-Nettokosten", Math.abs(t72.advantage - (t72.leasingTotalCost - t72.financeNetCost)) < 0.01);

    // 73. Auto-Leasing-/Finanzierungsrechner: Anzahlung höher als Fahrzeugpreis wird abgefangen
    const t73 = calculateCarFinancing({ price: 30000, downPayment: 35000, months: 36, leasingRate: 350, interestRate: 4, residualValue: 15000 });
    assert("Auto-Leasing/Finanzierung: zu hohe Anzahlung wird als Fehler erkannt", !!t73.error);

    console.groupEnd();
  }

  /* ======================================================================
     UMSATZSTEUERRECHNER
     ====================================================================== */

  function calculateVat(inp) {
    if (!isFinite(inp.amount) || inp.amount <= 0) return { error: "Der Betrag muss größer als 0 € sein." };
    if (!isFinite(inp.rate) || inp.rate < 0) return { error: "Der Steuersatz darf nicht negativ sein." };

    let net, vat, gross;
    if (inp.direction === "brutto") {
      gross = inp.amount;
      net = gross / (1 + inp.rate / 100);
      vat = gross - net;
    } else {
      net = inp.amount;
      vat = net * (inp.rate / 100);
      gross = net + vat;
    }
    return { net, vat, gross };
  }

  function initVatCalculator() {
    const form = document.getElementById("ust-form");
    if (!form) return;

    function run() {
      const result = calculateVat({
        amount: parseNumberInput(document.getElementById("ust-amount")),
        rate: parseFloat(document.getElementById("ust-rate").value),
        direction: document.getElementById("ust-direction").value
      });

      const errorEl = document.getElementById("ust-error");
      const resultsEl = document.getElementById("ust-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("ust-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Nettobetrag", formatEuroCents(result.net)));
      grid.appendChild(createResultItem("Umsatzsteuer", formatEuroCents(result.vat)));
      grid.appendChild(createResultItem("Bruttobetrag", formatEuroCents(result.gross)));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) {
      if (e.target && (e.target.type === "range" || e.target.tagName === "SELECT") && !document.getElementById("ust-results").hidden) run();
    });

    document.getElementById("ust-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("ust-results").hidden = true;
      document.getElementById("ust-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("ust-results").hidden = false;
    run();
  }

  /* ======================================================================
     BENZINKOSTENRECHNER
     ====================================================================== */

  function calculateFuelCost(inp) {
    if (!isFinite(inp.kmPerYear) || inp.kmPerYear <= 0) return { error: "Die Jahresfahrleistung muss größer als 0 km sein." };
    if (!isFinite(inp.consumption) || inp.consumption <= 0) return { error: "Der Verbrauch muss größer als 0 l/100 km sein." };
    if (!isFinite(inp.pricePerLiter) || inp.pricePerLiter <= 0) return { error: "Der Kraftstoffpreis muss größer als 0 €/l sein." };

    const litersPerYear = (inp.kmPerYear / 100) * inp.consumption;
    const costPerYear = litersPerYear * inp.pricePerLiter;
    const costPerMonth = costPerYear / 12;
    const costPer100km = inp.consumption * inp.pricePerLiter;

    return { litersPerYear, costPerYear, costPerMonth, costPer100km };
  }

  function initFuelCostCalculator() {
    const form = document.getElementById("bk-form");
    if (!form) return;

    function run() {
      const result = calculateFuelCost({
        kmPerYear: parseNumberInput(document.getElementById("bk-km")),
        consumption: parseNumberInput(document.getElementById("bk-consumption")),
        pricePerLiter: parseNumberInput(document.getElementById("bk-price"))
      });

      const errorEl = document.getElementById("bk-error");
      const resultsEl = document.getElementById("bk-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("bk-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Kraftstoffkosten pro Monat", formatEuro(result.costPerMonth)));
      grid.appendChild(createResultItem("Kraftstoffkosten pro Jahr", formatEuro(result.costPerYear)));
      grid.appendChild(createResultItem("Verbrauchte Liter pro Jahr", formatNumber(result.litersPerYear, 0) + " l"));
      grid.appendChild(createResultItem("Kosten je 100 km", formatEuroCents(result.costPer100km)));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("bk-results").hidden) run(); });

    document.getElementById("bk-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("bk-results").hidden = true;
      document.getElementById("bk-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("bk-results").hidden = false;
    run();
  }

  /* ======================================================================
     BAUFINANZIERUNGSRECHNER
     Nutzt die bereits vorhandene calculateRemainingDebt()-Funktion
     (Annuitätendarlehen) für die Restschuldberechnung.
     ====================================================================== */

  function estimatePayoffYears(loanAmount, annualInterestPercent, annualRepaymentPercent) {
    if (!isFinite(loanAmount) || loanAmount <= 0) return null;
    const monthlyInterestRate = annualInterestPercent / 100 / 12;
    const monthlyAnnuity = loanAmount * (annualInterestPercent + annualRepaymentPercent) / 100 / 12;
    let remaining = loanAmount;
    let months = 0;
    const maxMonths = 720; // Sicherheitsdeckel bei 60 Jahren
    while (remaining > 0.5 && months < maxMonths) {
      const interestPortion = remaining * monthlyInterestRate;
      const principalPortion = monthlyAnnuity - interestPortion;
      if (principalPortion <= 0) return null; // Rate deckt nicht einmal die Zinsen
      remaining -= principalPortion;
      months++;
    }
    return months >= maxMonths ? null : months / 12;
  }

  function calculateMortgage(inp) {
    if (!isFinite(inp.loanAmount) || inp.loanAmount <= 0) return { error: "Die Darlehenssumme muss größer als 0 € sein." };
    if (!isFinite(inp.interestRate) || inp.interestRate < 0) return { error: "Der Sollzins darf nicht negativ sein." };
    if (!isFinite(inp.repaymentRate) || inp.repaymentRate <= 0) return { error: "Die anfängliche Tilgung muss größer als 0 % sein." };
    if (!isFinite(inp.fixedYears) || inp.fixedYears <= 0) return { error: "Die Zinsbindung muss mindestens 1 Jahr betragen." };

    const monthlyPayment = inp.loanAmount * (inp.interestRate + inp.repaymentRate) / 100 / 12;
    const remainingDebt = calculateRemainingDebt(inp.loanAmount, inp.interestRate, inp.repaymentRate, inp.fixedYears);
    const totalPaid = monthlyPayment * inp.fixedYears * 12;
    const principalPaid = inp.loanAmount - remainingDebt;
    const interestPaid = totalPaid - principalPaid;
    const payoffYears = estimatePayoffYears(inp.loanAmount, inp.interestRate, inp.repaymentRate);

    return { monthlyPayment, remainingDebt, totalPaid, principalPaid, interestPaid, payoffYears };
  }

  function initMortgageCalculator() {
    const form = document.getElementById("bf-form");
    if (!form) return;

    function run() {
      const result = calculateMortgage({
        loanAmount: parseNumberInput(document.getElementById("bf-loan")),
        interestRate: parseNumberInput(document.getElementById("bf-interest")),
        repaymentRate: parseNumberInput(document.getElementById("bf-repayment")),
        fixedYears: parseNumberInput(document.getElementById("bf-years"))
      });

      const errorEl = document.getElementById("bf-error");
      const resultsEl = document.getElementById("bf-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("bf-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Monatliche Rate (Zins + Tilgung)", formatEuro(result.monthlyPayment)));
      grid.appendChild(createResultItem("Restschuld am Ende der Zinsbindung", formatEuro(result.remainingDebt)));
      grid.appendChild(createResultItem("Gezahlte Zinsen in der Zinsbindung", formatEuro(result.interestPaid)));
      grid.appendChild(createResultItem("Getilgter Betrag in der Zinsbindung", formatEuro(result.principalPaid)));
      grid.appendChild(createResultItem(
        "Geschätzte Volltilgung bei gleichbleibender Rate",
        result.payoffYears ? formatNumber(result.payoffYears, 1) + " Jahre" : "über 60 Jahre / nicht erreichbar"
      ));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("bf-results").hidden) run(); });

    document.getElementById("bf-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("bf-results").hidden = true;
      document.getElementById("bf-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("bf-results").hidden = false;
    run();
  }

  /* ======================================================================
     AUTO-LEASING- & FINANZIERUNGSRECHNER
     Vergleicht Leasing (Anzahlung + feste Monatsraten, Fahrzeug bleibt fremd)
     mit Finanzierung/Kauf per Kredit (Anzahlung + Annuitätenrate, am Ende
     gehört das Fahrzeug und hat noch einen Restwert).
     ====================================================================== */

  function calculateCarFinancing(inp) {
    if (!isFinite(inp.price) || inp.price <= 0) return { error: "Der Fahrzeugpreis muss größer als 0 € sein." };
    if (!isFinite(inp.downPayment) || inp.downPayment < 0) return { error: "Die Anzahlung darf nicht negativ sein." };
    if (inp.downPayment > inp.price) return { error: "Die Anzahlung darf nicht höher als der Fahrzeugpreis sein." };
    if (!isFinite(inp.months) || inp.months <= 0) return { error: "Die Laufzeit muss größer als 0 Monate sein." };
    if (!isFinite(inp.leasingRate) || inp.leasingRate < 0) return { error: "Die Leasingrate darf nicht negativ sein." };
    if (!isFinite(inp.interestRate) || inp.interestRate < 0) return { error: "Der Sollzins darf nicht negativ sein." };
    if (!isFinite(inp.residualValue) || inp.residualValue < 0) return { error: "Der erwartete Restwert darf nicht negativ sein." };

    const leasingTotalCost = inp.downPayment + inp.leasingRate * inp.months;

    const loanAmount = inp.price - inp.downPayment;
    const monthlyRate = inp.interestRate / 100 / 12;
    const financeMonthlyPayment = monthlyRate === 0
      ? loanAmount / inp.months
      : loanAmount * monthlyRate / (1 - Math.pow(1 + monthlyRate, -inp.months));
    const financeTotalPayments = inp.downPayment + financeMonthlyPayment * inp.months;
    const financeNetCost = financeTotalPayments - inp.residualValue;

    const advantage = leasingTotalCost - financeNetCost;
    const cheaperOption = advantage > 0 ? "finanzierung" : (advantage < 0 ? "leasing" : "gleich");

    return { leasingTotalCost, financeMonthlyPayment, financeTotalPayments, financeNetCost, advantage, cheaperOption };
  }

  function initCarFinancingCalculator() {
    const form = document.getElementById("af-form");
    if (!form) return;

    function run() {
      const result = calculateCarFinancing({
        price: parseNumberInput(document.getElementById("af-price")),
        downPayment: parseNumberInput(document.getElementById("af-down")),
        months: parseNumberInput(document.getElementById("af-months")),
        leasingRate: parseNumberInput(document.getElementById("af-leasingrate")),
        interestRate: parseNumberInput(document.getElementById("af-interest")),
        residualValue: parseNumberInput(document.getElementById("af-residual"))
      });

      const errorEl = document.getElementById("af-error");
      const resultsEl = document.getElementById("af-results");
      if (result.error) {
        errorEl.textContent = result.error;
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      errorEl.hidden = true;

      const grid = document.getElementById("af-result-grid");
      clearChildren(grid);
      grid.appendChild(createResultItem("Leasing – Gesamtkosten über Laufzeit", formatEuro(result.leasingTotalCost)));
      grid.appendChild(createResultItem("Finanzierung – monatliche Kreditrate", formatEuro(result.financeMonthlyPayment)));
      grid.appendChild(createResultItem("Finanzierung – Nettokosten (abzüglich Restwert)", formatEuro(result.financeNetCost)));
      grid.appendChild(createResultItem(
        result.cheaperOption === "finanzierung" ? "Vorteil Finanzierung gegenüber Leasing" : (result.cheaperOption === "leasing" ? "Vorteil Leasing gegenüber Finanzierung" : "Kein Unterschied"),
        formatEuro(Math.abs(result.advantage)),
        result.cheaperOption === "leasing" ? "negative" : "positive"
      ));

      const wasHidden = resultsEl.hidden;
      resultsEl.hidden = false;
      if (wasHidden) resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type === "range" && !document.getElementById("af-results").hidden) run(); });

    document.getElementById("af-reset").addEventListener("click", function () {
      form.reset();
      initSliders(form);
      document.getElementById("af-results").hidden = true;
      document.getElementById("af-error").hidden = true;
    });

    // Ergebnis beim ersten automatischen Berechnen still einblenden (kein Scroll-Jump).
    document.getElementById("af-results").hidden = false;
    run();
  }

  /* ===================== PWA: Service-Worker-Registrierung ===================== */

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Service Worker funktionieren nur über HTTPS oder localhost, nie über
    // file:// – dort schlägt die Registrierung erwartungsgemäß fehl und wird
    // hier bewusst still abgefangen.
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* Kein Internet, file://-Aufruf oder Server ohne SW-Unterstützung –
           die Seite funktioniert auch ohne Service Worker normal weiter. */
      });
    });
  }

  registerServiceWorker();

  /* ===================== Initialisierung ===================== */

  function init() {
    initSliders();
    initMobileNav();
    initNavDropdowns();
    initFaq();
    initPropertyCalculator();
    initEvCalculator();
    initPvCalculator();
    initCompoundInterestCalculator();
    initWithdrawalPlanCalculator();
    initHeatPumpCalculator();
    initRenovationCalculator();
    initRentalYieldCalculator();
    initRentVsBuyCalculator();
    initHouseCostsCalculator();
    initInsuranceCheckCalculator();
    initSavingsPlanCalculator();
    initPensionGapCalculator();
    initLoanComparisonCalculator();
    initInflationCalculator();
    initMovingCalculator();
    initObjectCompareCalculator();
    initGrossNetCalculator();
    initFeasibilityCalculator();
    initGesamtplanCalculator();
    initVatCalculator();
    initFuelCostCalculator();
    initMortgageCalculator();
    initCarFinancingCalculator();
    renderCalculatorOverview();
    initPricingDemoButtons();
    initProGateButtons();
    initExposeUpload();
    initFinderForm();
    initEnergySavingsCalculator();
    initTariffForm();
    initInsuranceForm();
    initAccountForms();
    initLegalLinks();
    initShareResultButtons();
    renderStammdatenProgressWidgets();
    initReferralWidgets();
    initQuickStartQuiz();
    runSelfTests();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
