export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface IDatabaseService {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (client: IDatabaseClient) => Promise<T>): Promise<T>;
  isHealthy(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }>;
}
