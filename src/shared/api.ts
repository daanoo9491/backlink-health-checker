/**
 * Types shared by the Worker (backend) and the React app (frontend).
 * Keep machine-readable values here; friendly UI labels live in the client.
 */

export interface HealthResponse {
  status: 'ok';
  app: string;
  environment: string;
  version: string;
  timestamp: string;
}

/** Every API error has this shape. Never contains stack traces. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
