export interface ContractRoute {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly service: string;
  readonly security: readonly string[];
  readonly scope?: string;
  readonly audience?: string;
  readonly clients?: readonly string[];
  readonly role?: string;
  readonly introspection: boolean;
  readonly headers: readonly {
    name: string;
    required: boolean;
    minLength?: number;
    maxLength?: number;
  }[];
  readonly requestTypes: readonly string[];
  readonly responses: Readonly<
    Record<
      string,
      {
        types: readonly string[];
        codes: readonly string[];
        headers: readonly string[];
      }
    >
  >;
}
