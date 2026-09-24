/**
 * Types shared by the Worker (backend) and the React app (frontend).
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

export interface SessionUser {
  email: string;
}

export interface MeResponse {
  user: SessionUser;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RecentScan {
  id: string;
  fileName: string;
  createdAt: string;
  urlsChecked: number;
  active: number;
  dead: number;
  issues: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface DashboardSummary {
  totalScans: number;
  urlsChecked: number;
  activeLinks: number;
  deadLinks: number;
  issuesFound: number;
  recentScans: RecentScan[];
}
