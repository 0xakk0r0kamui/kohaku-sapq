export type PQStealthErrorCode =
  | 'MalformedMetaAddress'
  | 'MissingOperationalState'
  | 'RoleMismatch'
  | 'ChannelOpeningPending'
  | 'InsufficientGas'
  | 'StorageFailure'
  | 'MigrationRequired'
  | 'InvalidOperationState'
  | 'SignerMismatch'
  | 'SignerUnavailable';

export class PQStealthError extends Error {
  constructor(
    readonly code: PQStealthErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PQStealthError';
  }
}
