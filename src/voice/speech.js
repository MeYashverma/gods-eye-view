/**
 * Browser speech input.
 *
 * Uses the Web Speech API where it exists and says clearly when it does not.
 * There is no server round trip, no API key and no always-on model: the
 * microphone is opened only while the operator holds the listening state, and
 * the browser's own permission prompt is the gate.
 *
 * The spoken feedback is limited to what the executor actually returned. If a
 * place search fails, the reply is "I could not find that" — not a plausible
 * sounding confirmation.
 */

import { parseCommand, INTENTS } from './commands.js';

export function speechSupport() {
  const SpeechRecognition =
    (typeof window !== 'undefined' &&
      (window.SpeechRecognition || window.webkitSpeechRecognition)) ||
    null;
  return {
    supported: Boolean(SpeechRecognition),
    reason: SpeechRecognition
      ? null
      : 'This browser does not expose the Web Speech API. Chrome, Edge and Safari support it; Firefox does not.',
    SpeechRecognition,
  };
}

export function createSpeechController({ onIntent, onTranscript, onStatus, vocabulary }) {
  const support = speechSupport();
  let recognition = null;
  let listening = false;
  let restartTimer = null;

  if (support.SpeechRecognition) {
    recognition = new support.SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript || '';
      onTranscript?.(transcript);
      const intent = parseCommand(transcript, vocabulary);
      onIntent?.(intent, transcript);
    };
    recognition.onerror = (event) => {
      const message = describeError(event.error);
      onStatus?.({ listening: false, error: message });
      listening = false;
    };
    recognition.onend = () => {
      listening = false;
      onStatus?.({ listening: false, error: null });
    };
  }

  function start() {
    if (!recognition) {
      onStatus?.({ listening: false, error: support.reason });
      return false;
    }
    if (listening) return true;
    try {
      recognition.start();
      listening = true;
      onStatus?.({ listening: true, error: null });
      return true;
    } catch (error) {
      // Starting twice throws; treat it as already running.
      onStatus?.({ listening: true, error: null });
      return true;
    }
  }

  function stop() {
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* not started */
    }
    listening = false;
  }

  return {
    start,
    stop,
    toggle() {
      return listening ? (stop(), false) : start();
    },
    get listening() {
      return listening;
    },
    get supported() {
      return support.supported;
    },
    get unsupportedReason() {
      return support.reason;
    },
    /** Continuous listening for hands-free use; still gated by the browser. */
    setContinuous(value) {
      if (!recognition) return;
      recognition.continuous = Boolean(value);
      if (value && !listening) {
        start();
        restartTimer = setInterval(() => {
          if (!listening) start();
        }, 1200);
      } else if (restartTimer) {
        clearInterval(restartTimer);
        restartTimer = null;
      }
    },
    dispose() {
      if (restartTimer) clearInterval(restartTimer);
      stop();
    },
  };
}

function describeError(code) {
  switch (code) {
    case 'not-allowed':
      return 'Microphone permission was denied. Enable it in your browser settings to use voice control.';
    case 'service-not-allowed':
      return 'The browser blocked the speech service. This usually means a permission or policy setting.';
    case 'no-speech':
      return 'No speech was detected.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'The speech service could not be reached. Voice input needs a network connection.';
    case 'aborted':
      return null;
    default:
      return code ? `Speech input error: ${code}` : null;
  }
}

/**
 * Turn an executor result into something worth saying. Deliberately literal:
 * the reply describes the outcome, never the intention.
 */
export function describeResult(intent, result) {
  if (!result?.ok) {
    return result?.message || 'I could not do that.';
  }
  switch (intent) {
    case INTENTS.FLY_TO:
      return `Flying to ${result.label || 'that location'}.`;
    case INTENTS.SET_LAYER:
      return `${result.label} ${result.enabled ? 'on' : 'off'}.`;
    case INTENTS.STYLE:
      return `${result.label} look applied.`;
    case INTENTS.CAMERA:
      return result.message || 'Camera updated.';
    case INTENTS.TRACK:
      return result.enabled ? `Tracking ${result.label || 'the selection'}.` : 'Tracking stopped.';
    case INTENTS.SHARE:
      return 'Share link copied to the clipboard.';
    case INTENTS.CLEAN:
      return result.enabled ? 'Clean view on. Press escape to exit.' : 'Clean view off.';
    case INTENTS.REFRESH:
      return 'Refreshing visible layers.';
    case INTENTS.DESCRIBE:
      return result.message || 'Nothing is selected.';
    case INTENTS.HELP:
      return 'Try: fly to Tokyo, turn on earthquakes, night vision, reset camera.';
    default:
      return 'Done.';
  }
}
