/**
 * Process-local single-flight registry.
 *
 * The JobRun lookup protects against an already-running database row. This
 * registry closes the smaller race where two calls in the same worker process
 * both reach that lookup before either has created its row.
 */
export class LocalSingleFlight {
  readonly #active = new Set<string>();

  claim(name: string): boolean {
    if (this.#active.has(name)) return false;
    this.#active.add(name);
    return true;
  }

  release(name: string): void {
    this.#active.delete(name);
  }
}

export const jobSingleFlight = new LocalSingleFlight();
