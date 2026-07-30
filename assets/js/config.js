/* =====================================================================
   Steam Viewer — client configuration
   ---------------------------------------------------------------------
   After deploying the relay in `server/` to Render, paste its URL below
   and the site will connect automatically for every visitor.

   It can also be supplied at runtime (both override this file):
     • ?server=https://your-service.onrender.com   in the address bar
     • the gear icon in the header (saved to localStorage)
   ===================================================================== */

window.STEAM_VIEWER_CONFIG = {
  /** e.g. "https://steam-viewer-relay.onrender.com" — no trailing slash. */
  serverUrl: "https://steam-viewer-relay.onrender.com",

  /** Default store region (ISO 3166-1 alpha-2) — drives prices and currency. */
  defaultCountry: "us",

  /** Default store language for descriptions. */
  defaultLanguage: "english",

  /**
   * Render's free tier sleeps after inactivity; the first request can take
   * the better part of a minute while the container boots.
   */
  coldStartHintMs: 6000,
};
