/** Thrown when the selected provider does not offer an operation. Check `getCapabilities` first to avoid it. */
export class HarnessUnsupportedError extends Error {
  readonly code = 'unsupported' as const;
  constructor(readonly operation: string) {
    super(`${operation} is unavailable for this provider.`);
    this.name = 'HarnessUnsupportedError';
  }
}
