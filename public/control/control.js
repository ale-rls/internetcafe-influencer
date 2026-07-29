const form = document.querySelector("#notification-form");
const senderInput = document.querySelector("#sender");
const messageInput = document.querySelector("#message");
const messageCount = document.querySelector("#message-count");
const sendButton = document.querySelector("#send-button");
const sendStatus = document.querySelector("#send-status");
const preview = document.querySelector("#notification-preview");
const previewIcon = document.querySelector("#preview-icon");
const previewApp = document.querySelector("#preview-app");
const previewSender = document.querySelector("#preview-sender");
const previewMessage = document.querySelector("#preview-message");

const APP_PRESENTATION = {
  instagram: { label: "Instagram", glyph: "◎" },
  whatsapp: { label: "WhatsApp", glyph: "⌕" },
};

function selectedValue(name) {
  return form.elements[name].value;
}

function updatePreview() {
  const app = selectedValue("app");
  const presentation = APP_PRESENTATION[app];
  messageCount.textContent = String(messageInput.value.length);
  preview.className = `native-notification notification--${app}`;
  previewIcon.className = `app-icon app-icon--${app}`;
  previewIcon.textContent = presentation.glyph;
  previewApp.textContent = presentation.label;
  previewSender.textContent = senderInput.value.trim() || "internet.cafe";
  previewMessage.textContent = messageInput.value.trim() || "Your notification will appear here.";
}

function setStatus(message, kind = "") {
  sendStatus.textContent = message;
  sendStatus.className = `send-status${kind ? ` is-${kind}` : ""}`;
}

async function refreshConnections() {
  try {
    const response = await fetch("/healthz", { cache: "no-store" });
    if (!response.ok) return;
    const health = await response.json();
    for (const dot of document.querySelectorAll("[data-seat]")) {
      dot.classList.toggle("is-connected", health.seats?.[dot.dataset.seat]?.phone === true);
    }
  } catch {
    // The send action reports connection failures; status dots are best-effort.
  }
}

async function sendNotification() {
  if (!form.reportValidity()) return;
  sendButton.disabled = true;
  setStatus("Sending…");

  try {
    const response = await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seat: selectedValue("seat"),
        app: selectedValue("app"),
        sender: senderInput.value,
        message: messageInput.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Notification could not be sent");

    const delivered = result.deliveredSeats || [];
    if (delivered.length === 0) {
      setStatus("No selected phones are currently connected.", "error");
    } else {
      const seats = delivered.map((seat) => `seat ${seat}`).join(", ");
      const missing = result.missingSeats?.length
        ? ` Not connected: ${result.missingSeats.join(", ")}.`
        : "";
      setStatus(`Sent to ${seats}.${missing}`, "success");
    }
    await refreshConnections();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Notification could not be sent.", "error");
  } finally {
    sendButton.disabled = false;
  }
}

form.addEventListener("input", updatePreview);
form.addEventListener("change", updatePreview);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendNotification();
});
form.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendNotification();
  }
});

updatePreview();
void refreshConnections();
window.setInterval(refreshConnections, 2_000);
