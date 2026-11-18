document.addEventListener("DOMContentLoaded", async () => {
  const companyEl = document.getElementById("company");
  const roleEl = document.getElementById("role");
  const portalEl = document.getElementById("portal");
  const appIdEl = document.getElementById("portalApplicationId");
  const statusEl = document.getElementById("status");
  const sourceUrlEl = document.getElementById("sourceUrl");
  const statusMsg = document.getElementById("statusMsg");
  const captureBtn = document.getElementById("captureBtn");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      sourceUrlEl.value = tab.url;
      chrome.tabs.sendMessage(
        tab.id,
        { type: "CAREEROS_EXTRACT_PAGE" },
        (response) => {
          if (chrome.runtime.lastError || !response) return;
          if (response.blockedByChallenge) {
            statusMsg.style.color = "#fbbf24";
            statusMsg.textContent = response.reason;
            return;
          }
          if (response.company) companyEl.value = response.company;
          if (response.role) roleEl.value = response.role;
          if (response.portal) portalEl.value = response.portal;
          if (response.portalApplicationId)
            appIdEl.value = response.portalApplicationId;
          if (response.status) statusEl.value = response.status;
          if (response.sourceUrl) sourceUrlEl.value = response.sourceUrl;
        }
      );
    }
  } catch {
    // Allow manual input if activeTab message is unavailable
  }

  captureBtn.addEventListener("click", async () => {
    statusMsg.style.color = "#94a3b8";
    statusMsg.textContent = "Syncing with CareerOS...";

    try {
      const res = await fetch("http://localhost:3000/api/extension/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: companyEl.value.trim(),
          role: roleEl.value.trim(),
          portal: portalEl.value,
          portalApplicationId: appIdEl.value.trim() || null,
          status: statusEl.value,
          sourceUrl: sourceUrlEl.value.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Capture failed");
      }

      statusMsg.style.color = "#34d399";
      statusMsg.textContent = data.deduplicated
        ? `Updated existing application (${data.application.company})`
        : `Captured ${data.application.company} to CareerOS!`;
    } catch (err) {
      statusMsg.style.color = "#f87171";
      statusMsg.textContent = err.message || "Could not connect to CareerOS";
    }
  });
});
