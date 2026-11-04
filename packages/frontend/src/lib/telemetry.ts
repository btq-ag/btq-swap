import { API_URL } from './constants';

type TelemetryPayload = Record<string, unknown>;

export async function trackEvent(event: string, payload: TelemetryPayload = {}): Promise<void> {
  try {
    await fetch(`${API_URL}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        payload,
        ts: new Date().toISOString(),
      }),
    });
  } catch {
    // Telemetry should never block user actions.
  }
}
