// ==UserScript==
// @name         Revive Status Display
// @namespace    http://tampermonkey.net/
// @version      1.0.5
// @description  Display REVIVE beside war-rank players you can revive.
// @author       You
// @match        https://www.torn.com/profiles.php*
// @match        https://www.torn.com/factions.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  "use strict";

  // ============================================================
  // CONFIG
  // ============================================================

  const STORAGE_KEY = "reviveStatusDisplay.apiKey";

  const API_BASE = "https://api.torn.com/v2";

  const PANEL_ID = "revive-status-api-panel";

  const REVIVE_MARKER_CLASS = "revive-status-war-marker";

  const REFRESH_INTERVAL = 30_000;

  /*
   * Current Torn ranked-war member rows.
   */
  const WAR_MEMBER_SELECTOR =
    "ul.members-list li.your, ul.members-list li.enemy";

  let refreshTimer = null;

  let navigationTimer = null;

  let mutationObserver = null;

  let lastUrl = location.href;

  let loadingWarData = false;

  /*
   * user ID -> {
   *   id,
   *   factionId,
   *   is_revivable,
   *   ...
   * }
   */
  let memberData = new Map();

  /*
   * Current war information.
   */
  let currentWar = null;

  /*
   * Used to avoid hammering Torn while the DOM is being rebuilt.
   */
  let applyQueued = false;

  // ============================================================
  // API KEY
  // ============================================================

  function getApiKey() {
    return localStorage.getItem(STORAGE_KEY) || "";
  }

  function setApiKey(key) {
    key = String(key || "").trim();

    if (key) {
      localStorage.setItem(STORAGE_KEY, key);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  // ============================================================
  // TORN API
  // ============================================================

  async function tornFetch(path, params = {}, apiKey = getApiKey()) {
    if (!apiKey) {
      throw new Error("No API key configured.");
    }

    const query = new URLSearchParams(params);

    const url =
      `${API_BASE}${path}` + (query.toString() ? `?${query.toString()}` : "");

    const response = await fetch(url, {
      method: "GET",

      headers: {
        Accept: "application/json",

        Authorization: `ApiKey ${apiKey}`,
      },
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(`Torn returned invalid JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      throw new Error(
        `Torn API HTTP ${response.status}: ${response.statusText}`,
      );
    }

    if (data?.error) {
      throw new Error(`Torn API ${data.error.code}: ${data.error.error}`);
    }

    return data;
  }

  // ============================================================
  // USER PROFILE
  // ============================================================

  async function fetchCurrentUser(apiKey = getApiKey()) {
    /*
     * IMPORTANT:
     *
     * Use /user/profile, not /user/basic.
     *
     * Current Torn v2 profile data includes faction_id.
     */
    return tornFetch("/user/profile", {}, apiKey);
  }

  // ============================================================
  // FACTION MEMBERS
  // ============================================================

  async function fetchOwnFactionMembers(apiKey = getApiKey()) {
    /*
     * This endpoint means YOUR faction.
     */
    const data = await tornFetch("/faction/members", {}, apiKey);

    if (!Array.isArray(data?.members)) {
      throw new Error("Torn returned an unexpected /faction/members response.");
    }

    return data.members;
  }

  async function fetchFactionMembers(factionId, apiKey = getApiKey()) {
    if (!factionId) {
      throw new Error("No faction ID provided.");
    }

    const data = await tornFetch(
      `/faction/${encodeURIComponent(factionId)}/members`,
      {},
      apiKey,
    );

    if (Array.isArray(data?.members)) {
      return data.members;
    }

    /*
     * Defensive support in case a response is returned as
     * an object keyed by player ID.
     */
    if (data?.members && typeof data.members === "object") {
      return Object.entries(data.members).map(([id, member]) => ({
        ...member,
        id: member?.id ?? id,
      }));
    }

    throw new Error(`Unexpected member response for faction ${factionId}.`);
  }

  // ============================================================
  // RANKED WAR
  // ============================================================

  async function fetchFactionWars(factionId, apiKey = getApiKey()) {
    return tornFetch(
      `/faction/${encodeURIComponent(factionId)}/wars`,
      {},
      apiKey,
    );
  }

  /*
   * Convert whatever shape Torn returns for wars.ranked into
   * an array.
   */
  function getRankedWarCandidates(data) {
    const ranked = data?.wars?.ranked;

    if (!ranked) {
      return [];
    }

    if (Array.isArray(ranked)) {
      return ranked;
    }

    if (typeof ranked === "object") {
      /*
       * Normal current response is an object containing the
       * active ranked war.
       *
       * But supporting nested/object forms makes this resilient
       * to Torn's API representation.
       */
      if (Array.isArray(ranked.factions)) {
        return [ranked];
      }

      return Object.values(ranked).filter(
        (value) => value && typeof value === "object",
      );
    }

    return [];
  }

  /*
   * Find the active ranked war involving our faction.
   */
  function findActiveRankedWar(data, ownFactionId) {
    const candidates = getRankedWarCandidates(data);

    const ownId = String(ownFactionId);

    /*
     * Prefer a war which is explicitly ongoing.
     */
    const active = candidates.find((war) => {
      if (!Array.isArray(war?.factions)) {
        return false;
      }

      const containsOwnFaction = war.factions.some(
        (faction) => String(faction?.id) === ownId,
      );

      if (!containsOwnFaction) {
        return false;
      }

      /*
       * end == null means ongoing.
       */
      return war.end === null || war.end === undefined || Number(war.end) === 0;
    });

    if (active) {
      return active;
    }

    /*
     * Some API/UI states can omit end information.
     *
     * If there is only a war involving our faction,
     * use it as the fallback.
     */
    const involvingUs = candidates
      .filter(
        (war) =>
          Array.isArray(war?.factions) &&
          war.factions.some((faction) => String(faction?.id) === ownId),
      )
      .sort((a, b) => Number(b?.start || 0) - Number(a?.start || 0));

    return involvingUs[0] || null;
  }

  /*
   * Get the two factions participating in the war.
   */
  function getWarFactions(war, ownFactionId) {
    if (!war || !Array.isArray(war.factions)) {
      return null;
    }

    const factions = war.factions.filter((faction) => faction?.id);

    const ownId = String(ownFactionId);

    const own = factions.find((faction) => String(faction.id) === ownId);

    const enemy = factions.find((faction) => String(faction.id) !== ownId);

    if (!own || !enemy) {
      return null;
    }

    return {
      ownId: String(own.id),

      ownName: own.name || "",

      enemyId: String(enemy.id),

      enemyName: enemy.name || "",
    };
  }

  // ============================================================
  // PROFILE API PANEL
  // ============================================================

  function isProfilePage() {
    return location.pathname === "/profiles.php";
  }

  function getProfileId() {
    const params = new URLSearchParams(location.search);

    return params.get("XID");
  }

  async function isOwnProfile() {
    const profileId = getProfileId();

    if (!profileId) {
      return false;
    }

    const apiKey = getApiKey();

    /*
     * First run:
     * show the API key form.
     */
    if (!apiKey) {
      return null;
    }

    try {
      const user = await fetchCurrentUser(apiKey);

      const ownerId = user?.profile?.id;

      if (!ownerId) {
        throw new Error(
          "Torn /user/profile response did not contain profile.id.",
        );
      }

      return String(ownerId) === String(profileId);
    } catch (error) {
      console.error("[Revive Status] Failed to identify profile owner:", error);

      return false;
    }
  }

  function addStyles() {
    if (document.getElementById("revive-status-styles")) {
      return;
    }

    const style = document.createElement("style");

    style.id = "revive-status-styles";

    style.textContent = `
      /* =====================================================
         API PANEL
         ===================================================== */

      #${PANEL_ID} {
        box-sizing: border-box;

        width: calc(100% - 30px);
        max-width: 900px;

        margin: 25px auto 35px;
        padding: 16px;

        background:
          linear-gradient(
            180deg,
            rgba(40, 40, 40, .98),
            rgba(25, 25, 25, .98)
          );

        border: 1px solid #444;
        border-radius: 6px;

        color: #ddd;

        font-family: Arial, sans-serif;

        box-shadow:
          0 2px 8px rgba(0,0,0,.4);

        position: relative;
        z-index: 100;
      }

      #${PANEL_ID} h3 {
        margin: 0 0 7px;

        color: #eee;

        font-size: 16px;
      }

      #${PANEL_ID} .revive-description {
        margin: 0 0 13px;

        color: #aaa;

        font-size: 12px;

        line-height: 1.5;
      }

      #${PANEL_ID} .revive-api-row {
        display: flex;

        align-items: center;

        gap: 7px;
      }

      #${PANEL_ID} input {
        flex: 1;

        min-width: 0;

        box-sizing: border-box;

        padding: 9px 10px;

        border: 1px solid #444;
        border-radius: 4px;

        background: #111;
        color: #eee;

        font-family: monospace;

        font-size: 13px;
      }

      #${PANEL_ID} input:focus {
        outline: none;
        border-color: #777;
      }

      #${PANEL_ID} button {
        padding: 9px 12px;

        border: 1px solid #555;
        border-radius: 4px;

        background: #333;
        color: #eee;

        cursor: pointer;

        white-space: nowrap;
      }

      #${PANEL_ID} button:hover {
        background: #444;
      }

      #${PANEL_ID} button.primary {
        background: #385d38;
        border-color: #507850;
      }

      #${PANEL_ID} button.primary:hover {
        background: #477447;
      }

      #${PANEL_ID} .revive-api-status {
        min-height: 17px;

        margin-top: 10px;

        font-size: 12px;
      }

      #${PANEL_ID} .success {
        color: #6fdc8c;
      }

      #${PANEL_ID} .error {
        color: #ff7777;
      }

      #${PANEL_ID} .info {
        color: #aaa;
      }


      /* =====================================================
         REVIVE INDICATOR
         ===================================================== */

      .${REVIVE_MARKER_CLASS} {
        display: inline-flex;

        align-items: center;
        justify-content: center;

        box-sizing: border-box;

        margin-left: 6px;

        padding: 4px;

        border: 1px solid #4c9a5a;
        border-radius: 3px;

        background:
          linear-gradient(
            180deg,
            rgba(65, 150, 80, .32),
            rgba(35, 100, 48, .32)
          );

        color: #76ee8c !important;

        font-family: Arial, sans-serif;

        font-size: 9px;

        font-weight: bold;

        line-height: 1.1;

        text-transform: uppercase;

        vertical-align: middle;

        white-space: nowrap;

        text-shadow:
          0 1px 1px rgba(0,0,0,.5);

        box-shadow:
          0 0 4px rgba(70,220,100,.12);

        cursor: default;

        pointer-events: none;
      }

      .${REVIVE_MARKER_CLASS}:hover {
        color: #76ee8c !important;
      }


      @media (max-width: 600px) {
        #${PANEL_ID} .revive-api-row {
          flex-wrap: wrap;
        }

        #${PANEL_ID} input {
          flex-basis: 100%;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function getProfileContainer() {
    return document.querySelector(".content-wrapper") || document.body;
  }

  function createApiPanel() {
    if (document.getElementById(PANEL_ID)) {
      return;
    }

    addStyles();

    const panel = document.createElement("section");

    panel.id = PANEL_ID;

    const heading = document.createElement("h3");

    heading.textContent = "Revive Status — Torn API";

    const description = document.createElement("p");

    description.className = "revive-description";

    description.textContent =
      "Enter your Torn API key to enable REVIVE indicators on the ranked war page. " +
      "The key is stored only in this browser.";

    const row = document.createElement("div");

    row.className = "revive-api-row";

    const input = document.createElement("input");

    input.type = "password";

    input.placeholder = "Torn API key";

    input.autocomplete = "off";

    input.spellcheck = false;

    input.value = getApiKey();

    const showButton = document.createElement("button");

    showButton.type = "button";

    showButton.textContent = "Show";

    const saveButton = document.createElement("button");

    saveButton.type = "button";

    saveButton.className = "primary";

    saveButton.textContent = "Save";

    const testButton = document.createElement("button");

    testButton.type = "button";

    testButton.textContent = "Test";

    const clearButton = document.createElement("button");

    clearButton.type = "button";

    clearButton.textContent = "Clear";

    const status = document.createElement("div");

    status.className = "revive-api-status info";

    if (getApiKey()) {
      status.textContent = "API key saved. Open the ranked war page to use it.";
    }

    showButton.addEventListener("click", () => {
      const hidden = input.type === "password";

      input.type = hidden ? "text" : "password";

      showButton.textContent = hidden ? "Hide" : "Show";
    });

    async function testKey(key, save) {
      status.className = "revive-api-status info";

      status.textContent = "Checking API key...";

      try {
        const user = await fetchCurrentUser(key);

        const id = user?.profile?.id;

        if (!id) {
          throw new Error("Torn response is missing user.profile.id.");
        }

        if (save) {
          setApiKey(key);
        }

        const name = user?.profile?.name || `ID ${id}`;

        const factionId = user?.profile?.faction_id;

        status.className = "revive-api-status success";

        status.textContent = factionId
          ? `Connected as ${name} [${id}]. Faction ${factionId}.`
          : `Connected as ${name} [${id}].`;

        return true;
      } catch (error) {
        console.error("[Revive Status] API test failed:", error);

        status.className = "revive-api-status error";

        status.textContent = error.message;

        return false;
      }
    }

    saveButton.addEventListener("click", async () => {
      const key = input.value.trim();

      if (!key) {
        status.className = "revive-api-status error";

        status.textContent = "Enter an API key first.";

        return;
      }

      const success = await testKey(key, true);

      if (success && isRankedWarPage()) {
        await loadWarReviveStatus();
      }
    });

    testButton.addEventListener("click", async () => {
      const key = input.value.trim();

      if (!key) {
        status.className = "revive-api-status error";

        status.textContent = "Enter an API key first.";

        return;
      }

      await testKey(key, false);
    });

    clearButton.addEventListener("click", () => {
      setApiKey("");

      input.value = "";

      status.className = "revive-api-status info";

      status.textContent = "API key removed.";

      memberData.clear();

      currentWar = null;

      removeAllReviveMarkers();
    });

    row.append(input, showButton, saveButton, testButton, clearButton);

    panel.append(heading, description, row, status);

    getProfileContainer().appendChild(panel);
  }

  function removeApiPanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  // ============================================================
  // WAR PAGE DETECTION
  // ============================================================

  function isRankedWarPage() {
    if (location.pathname !== "/factions.php") {
      return false;
    }

    /*
     * The current ranked-war UI uses the hash router.
     *
     * Example:
     *
     * factions.php?step=your&type=1#/war/rank
     */
    return location.hash.startsWith("#/war/rank");
  }

  // ============================================================
  // WAR DOM
  // ============================================================

  function getWarMemberRows() {
    return Array.from(document.querySelectorAll(WAR_MEMBER_SELECTOR));
  }

  function getUserIdFromProfileLink(link) {
    if (!link) {
      return null;
    }

    try {
      const url = new URL(link.href, location.origin);

      const id = url.searchParams.get("XID");

      return id ? String(id) : null;
    } catch {
      return null;
    }
  }

  function getWarMemberInfo(row) {
    if (!row) {
      return null;
    }

    /*
     * Torn's war member rows contain profile links.
     */
    const profileLink = row.querySelector('a[href*="profiles.php"]');

    if (!profileLink) {
      return null;
    }

    const id = getUserIdFromProfileLink(profileLink);

    if (!id) {
      return null;
    }

    return {
      id,
      row,
      profileLink,
    };
  }

  // ============================================================
  // REVIVE MARKERS
  // ============================================================

  function removeAllReviveMarkers() {
    document
      .querySelectorAll(`.${REVIVE_MARKER_CLASS}`)
      .forEach((marker) => marker.remove());
  }

  function removeReviveMarker(row) {
    if (!row) {
      return;
    }

    row
      .querySelectorAll(`.${REVIVE_MARKER_CLASS}`)
      .forEach((marker) => marker.remove());
  }

  function addReviveMarker(profileLink, userId) {
    if (!profileLink || !userId) {
      return;
    }

    /*
     * Avoid duplicate markers.
     */
    const parent = profileLink.parentElement;
    const someAncestor = parent.parentElement.parentElement.parentElement;

    if (
      someAncestor
        ?.querySelector(".status")
        ?.querySelector(`.${REVIVE_MARKER_CLASS}`)
    ) {
      return;
    }

    console.log("great-great-grandparent", someAncestor);

    const marker = document.createElement("div");

    marker.className = REVIVE_MARKER_CLASS;

    marker.textContent = "R";

    marker.title = "This user has their revives enabled.";

    /*
     * Directly beside the player's status.
     */
    const status = someAncestor?.querySelector(".status");
    status.style.display = "flex";
    status.style.gap = "4px";

    if (!status) {
      return;
    }

    status.appendChild(marker);
  }

  /*
   * Apply the API data to both sides of the war.
   */
  function applyReviveMarkers() {
    if (!isRankedWarPage()) {
      return;
    }

    const rows = getWarMemberRows();

    for (const row of rows) {
      const info = getWarMemberInfo(row);

      if (!info) {
        continue;
      }

      const member = memberData.get(info.id);

      /*
       * No API data:
       *
       * Don't display anything.
       */
      if (!member) {
        removeReviveMarker(row);

        continue;
      }

      /*
       * THE ONLY CONDITION FOR SHOWING REVIVE STATUS.
       *
       * true  -> green R
       * false -> nothing
       * other -> nothing
       */
      if (member.is_revivable === true) {
        addReviveMarker(info.profileLink, info.id);
      } else {
        removeReviveMarker(row);
      }
    }
  }

  function queueApplyReviveMarkers() {
    if (applyQueued) {
      return;
    }

    applyQueued = true;

    requestAnimationFrame(() => {
      applyQueued = false;

      applyReviveMarkers();
    });
  }

  // ============================================================
  // LOAD BOTH FACTIONS
  // ============================================================

  async function loadWarReviveStatus() {
    if (!isRankedWarPage()) {
      return;
    }

    const apiKey = getApiKey();

    if (!apiKey) {
      memberData.clear();

      currentWar = null;

      removeAllReviveMarkers();

      return;
    }

    /*
     * Prevent overlapping refreshes.
     */
    if (loadingWarData) {
      return;
    }

    loadingWarData = true;

    try {
      /*
       * --------------------------------------------------------
       * STEP 1
       *
       * Get our faction ID from /user/profile.
       * --------------------------------------------------------
       */
      const user = await fetchCurrentUser(apiKey);

      const ownFactionId = user?.profile?.faction_id;

      if (!ownFactionId) {
        throw new Error(
          "Torn /user/profile did not return profile.faction_id.",
        );
      }

      /*
       * --------------------------------------------------------
       * STEP 2
       *
       * Get the current ranked war.
       * --------------------------------------------------------
       */
      const wars = await fetchFactionWars(ownFactionId, apiKey);

      const war = findActiveRankedWar(wars, ownFactionId);

      if (!war) {
        /*
         * There is no active ranked war.
         */
        currentWar = null;

        memberData.clear();

        removeAllReviveMarkers();

        console.log("[Revive Status] No active ranked war found.");

        return;
      }

      const factions = getWarFactions(war, ownFactionId);

      if (!factions) {
        throw new Error(
          "Could not identify both factions in the active ranked war.",
        );
      }

      currentWar = {
        warId: war.war_id ?? war.id ?? null,

        ownFactionId: factions.ownId,

        ownFactionName: factions.ownName,

        enemyFactionId: factions.enemyId,

        enemyFactionName: factions.enemyName,
      };

      console.log("[Revive Status] Active ranked war:", currentWar);

      /*
       * --------------------------------------------------------
       * STEP 3
       *
       * Fetch BOTH factions.
       *
       * This is the important change from the previous version.
       * --------------------------------------------------------
       */
      const [ownMembers, enemyMembers] = await Promise.all([
        fetchOwnFactionMembers(apiKey),

        fetchFactionMembers(factions.enemyId, apiKey),
      ]);

      /*
       * --------------------------------------------------------
       * STEP 4
       *
       * Combine both member lists into one lookup.
       *
       * player ID -> member
       * --------------------------------------------------------
       */
      const newMemberData = new Map();

      for (const member of ownMembers) {
        if (!member?.id) {
          continue;
        }

        newMemberData.set(String(member.id), {
          ...member,

          factionId: factions.ownId,

          factionSide: "own",
        });
      }

      for (const member of enemyMembers) {
        if (!member?.id) {
          continue;
        }

        newMemberData.set(String(member.id), {
          ...member,

          factionId: factions.enemyId,

          factionSide: "enemy",
        });
      }

      memberData = newMemberData;

      /*
       * --------------------------------------------------------
       * STEP 5
       *
       * Apply indicators to both sides.
       * --------------------------------------------------------
       */
      applyReviveMarkers();

      /*
       * Useful debug information.
       */
      const revivableOwn = ownMembers.filter(
        (member) => member?.is_revivable === true,
      ).length;

      const revivableEnemy = enemyMembers.filter(
        (member) => member?.is_revivable === true,
      ).length;

      console.log("[Revive Status] Loaded war members:", {
        own: ownMembers.length,

        enemy: enemyMembers.length,

        ownRevivable: revivableOwn,

        enemyRevivable: revivableEnemy,
      });
    } catch (error) {
      console.error("[Revive Status] Failed to load war revive data:", error);

      /*
       * Don't leave stale REVIVE markers if the API failed.
       */
      memberData.clear();

      currentWar = null;

      removeAllReviveMarkers();
    } finally {
      loadingWarData = false;
    }
  }

  // ============================================================
  // DYNAMIC WAR UI
  // ============================================================

  function startMutationObserver() {
    stopMutationObserver();

    if (!isRankedWarPage()) {
      return;
    }

    mutationObserver = new MutationObserver((mutations) => {
      let changed = false;

      for (const mutation of mutations) {
        if (mutation.type !== "childList") {
          continue;
        }

        if (mutation.addedNodes.length || mutation.removedNodes.length) {
          changed = true;

          break;
        }
      }

      if (!changed) {
        return;
      }

      /*
       * Torn can rebuild the war rows.
       *
       * Reapply our markers after Torn finishes its DOM
       * update.
       */
      queueApplyReviveMarkers();
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function stopMutationObserver() {
    if (!mutationObserver) {
      return;
    }

    mutationObserver.disconnect();

    mutationObserver = null;
  }

  // ============================================================
  // WAR PAGE START / STOP
  // ============================================================

  async function startWarPage() {
    addStyles();

    startMutationObserver();

    /*
     * Torn may not have rendered the members yet.
     */
    setTimeout(() => {
      applyReviveMarkers();
    }, 500);

    /*
     * Load both factions.
     */
    await loadWarReviveStatus();

    /*
     * Refresh every 30 seconds.
     */
    refreshTimer = setInterval(() => {
      if (isRankedWarPage()) {
        loadWarReviveStatus().catch((error) => {
          console.error("[Revive Status] Refresh failed:", error);
        });
      }
    }, REFRESH_INTERVAL);
  }

  function stopWarPage() {
    if (refreshTimer) {
      clearInterval(refreshTimer);

      refreshTimer = null;
    }

    stopMutationObserver();

    memberData.clear();

    currentWar = null;

    removeAllReviveMarkers();
  }

  // ============================================================
  // PAGE CHECK
  // ============================================================

  async function checkPage() {
    /*
     * Stop previous timers/observers.
     */
    if (refreshTimer) {
      clearInterval(refreshTimer);

      refreshTimer = null;
    }

    stopMutationObserver();

    // ----------------------------------------------------------
    // PROFILE
    // ----------------------------------------------------------

    if (isProfilePage()) {
      const ownProfile = await isOwnProfile();

      /*
       * First run / no key.
       */
      if (ownProfile === null) {
        createApiPanel();

        return;
      }

      /*
       * Only show the key panel on our own profile.
       */
      if (ownProfile === true) {
        createApiPanel();
      } else {
        removeApiPanel();
      }

      return;
    }

    // ----------------------------------------------------------
    // LEAVING PROFILE
    // ----------------------------------------------------------

    removeApiPanel();

    // ----------------------------------------------------------
    // RANKED WAR
    // ----------------------------------------------------------

    if (isRankedWarPage()) {
      await startWarPage();

      return;
    }

    // ----------------------------------------------------------
    // EVERYTHING ELSE
    // ----------------------------------------------------------

    stopWarPage();
  }

  // ============================================================
  // TORN SPA NAVIGATION
  // ============================================================

  function watchNavigation() {
    if (navigationTimer) {
      clearInterval(navigationTimer);
    }

    navigationTimer = setInterval(() => {
      if (location.href === lastUrl) {
        return;
      }

      lastUrl = location.href;

      console.log("[Revive Status] Navigation:", location.href);

      checkPage().catch((error) => {
        console.error("[Revive Status] Page check failed:", error);
      });
    }, 500);
  }

  // ============================================================
  // INIT
  // ============================================================

  function init() {
    addStyles();

    checkPage().catch((error) => {
      console.error("[Revive Status] Initialisation failed:", error);
    });

    watchNavigation();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, {
      once: true,
    });
  } else {
    init();
  }

  // ============================================================
  // DEBUG API
  // ============================================================

  window.ReviveStatus = {
    fetchCurrentUser,

    fetchOwnFactionMembers,

    fetchFactionMembers,

    fetchFactionWars,

    getApiKey,

    setApiKey,

    loadWarReviveStatus,

    applyReviveMarkers,

    getCurrentWar: () => currentWar,
  };
})();
