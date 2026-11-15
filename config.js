"use strict";

/* ==========================================================================
   Geldhirn – config.js
   Zentrale Konfiguration für die Anbindung an externe Dienste
   (Supabase = Login/Datenbank, Stripe = Zahlungen/Abo).

   WICHTIG:
   - Diese Datei enthält AUSSCHLIESSLICH öffentliche Schlüssel/Links
     (Supabase "anon key", Stripe Payment Link, Stripe Customer-Portal-Link).
     Hier gehört NIEMALS ein geheimer Schlüssel hinein (kein Supabase
     "service_role"-Key, kein Stripe "Secret Key")! Diese Datei landet im
     Browser jedes Besuchers und ist dort einsehbar.
   - Solange unten die Platzhalter (Texte mit "DEIN-...") stehen, verhält
     sich die Website weiterhin genau wie bisher: reine Vorschau ohne
     echte Anmeldung, ohne echte Datenspeicherung, ohne echte Zahlung.
     Erst wenn du hier echte Werte einträgst, werden Login, Profil,
     persönliche Daten und die Pro-Mitgliedschaft "scharf geschaltet".
   - Eine ausführliche Schritt-für-Schritt-Anleitung, wie du an diese
     Werte kommst, steht in SETUP.md im Hauptordner.

   Diese Datei muss auf JEDER Seite VOR app.js eingebunden sein
   (das ist bereits so vorbereitet).
   ========================================================================== */

window.GELDHIRN_CONFIG = {
  // Supabase-Projekt-URL, z. B. "https://abcdefghijk.supabase.co"
  // Zu finden in: Supabase-Dashboard -> Project Settings -> API -> Project URL
  supabaseUrl: "DEIN-SUPABASE-PROJECT-URL",

  // Supabase "anon public"-Schlüssel (NICHT der "service_role"-Schlüssel!)
  // Zu finden in: Supabase-Dashboard -> Project Settings -> API -> Project API keys -> anon public
  supabaseAnonKey: "DEIN-SUPABASE-ANON-KEY",

  // Stripe Payment Link für die Pro-Mitgliedschaft, monatliche Zahlung
  // (4,99 €/Monat, wiederkehrend).
  // Zu finden/anzulegen in: Stripe-Dashboard -> Payment Links -> Neuer Payment Link
  // Beispiel: "https://buy.stripe.com/xxxxxxxxxxxx"
  stripePaymentLinkPro: "DEIN-STRIPE-PAYMENT-LINK",

  // Stripe Payment Link für die Pro-Mitgliedschaft, jährliche Zahlung
  // (39 €/Jahr, wiederkehrend – rund 35 % günstiger als 12x monatlich).
  // Als zweites, separates Produkt/Preis in Stripe anlegen (eigener
  // Payment Link mit jährlichem Abrechnungsintervall).
  stripePaymentLinkProAnnual: "DEIN-STRIPE-PAYMENT-LINK-JAHR",

  // Stripe Customer-Portal-Link (Selbstverwaltung: Zahlungsmethode ändern,
  // Rechnungen einsehen, Abo kündigen). Kunden melden sich dort nur mit
  // ihrer E-Mail-Adresse an (Stripe schickt einen Code) – kein eigenes
  // Login-System nötig.
  // Zu finden/anzulegen in: Stripe-Dashboard -> Einstellungen -> Kundenportal (Billing -> Customer portal)
  stripeCustomerPortalUrl: "DEIN-STRIPE-CUSTOMER-PORTAL-LINK"
};

/* Hilfsfunktion: prüft, ob ein Konfigurationswert noch der Platzhalter ist. */
window.GELDHIRN_CONFIG.isPlaceholder = function (value) {
  return !value || typeof value !== "string" || value.trim() === "" || value.indexOf("DEIN-") === 0;
};

/* Ist die Supabase-Anbindung (Login/Datenbank) vollständig konfiguriert? */
window.GELDHIRN_CONFIG.isSupabaseConfigured = function () {
  const c = window.GELDHIRN_CONFIG;
  return !c.isPlaceholder(c.supabaseUrl) && !c.isPlaceholder(c.supabaseAnonKey);
};

/* Ist der Stripe Payment Link für die Pro-Mitgliedschaft (Monat) hinterlegt? */
window.GELDHIRN_CONFIG.isStripePaymentLinkConfigured = function () {
  const c = window.GELDHIRN_CONFIG;
  return !c.isPlaceholder(c.stripePaymentLinkPro);
};

/* Ist der Stripe Payment Link für die Pro-Mitgliedschaft (Jahr) hinterlegt? */
window.GELDHIRN_CONFIG.isStripePaymentLinkAnnualConfigured = function () {
  const c = window.GELDHIRN_CONFIG;
  return !c.isPlaceholder(c.stripePaymentLinkProAnnual);
};

/* Ist der Stripe Customer-Portal-Link hinterlegt? */
window.GELDHIRN_CONFIG.isStripePortalConfigured = function () {
  const c = window.GELDHIRN_CONFIG;
  return !c.isPlaceholder(c.stripeCustomerPortalUrl);
};
