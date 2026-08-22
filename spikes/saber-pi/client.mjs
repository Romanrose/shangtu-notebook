const MAX_TEXT_LENGTH = 240;

function validIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function requireInk(image) {
  if (!image || typeof image !== "object" || image.mimeType !== "image/png" || typeof image.data !== "string") {
    throw new Error("invalid_ink");
  }
}

/**
 * A transport-injected client boundary for the future Flutter adapter.
 * Saber remains the owner of the ink object; this client only keeps an
 * opaque reference while a derived transcription or annotation is pending.
 */
export function createSaberPiClient({ transport, onLocalAwakening = () => {}, onStateChange = () => {} } = {}) {
  if (!transport || typeof transport.transcribe !== "function" || typeof transport.seek !== "function") {
    throw new Error("transport_required");
  }

  let state = { phase: "rest", pageId: null, strokeSegmentId: null, ink: null, transcription: null, result: null };
  const publish = (next) => {
    state = next;
    onStateChange(state);
    return state;
  };

  return {
    getState: () => state,

    async penUp({ pageId, strokeSegmentId, mode, image }) {
      if (!validIdentity(pageId) || !validIdentity(strokeSegmentId)) throw new Error("invalid_identity");
      requireInk(image);
      if (mode === "quiet") return publish({ phase: "quiet", pageId, strokeSegmentId, ink: image, transcription: null, result: null });
      if (mode !== "seek") throw new Error("invalid_mode");

      // This callback must stay before any await or transport call.
      publish({ phase: "awakening", pageId, strokeSegmentId, ink: image, transcription: null, result: null });
      onLocalAwakening({ pageId, strokeSegmentId });
      const response = await transport.transcribe({ pageId, strokeSegmentId, mode, image });
      if (response?.status === "ok" && response.transcription?.text) {
        return publish({ phase: "awaiting_confirmation", pageId, strokeSegmentId, ink: image, transcription: response.transcription, result: null });
      }
      return publish({ phase: "ready", pageId, strokeSegmentId, ink: image, transcription: null, result: response ?? { status: "unavailable" } });
    },

    async confirm({ text }) {
      const confirmedText = normalizeText(text);
      if (state.phase !== "awaiting_confirmation" || !confirmedText || !state.ink) throw new Error("confirmation_required");
      const response = await transport.seek({
        pageId: state.pageId,
        strokeSegmentId: state.strokeSegmentId,
        mode: "seek",
        image: state.ink,
        confirmedText,
      });
      return publish({ ...state, phase: "ready", result: response ?? { status: "unavailable" } });
    },
  };
}
