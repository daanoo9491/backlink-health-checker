/**
 * Counts outgoing requests (link fetches + DNS lookups) so one invocation
 * never exceeds the Workers free-plan limit of 50 subrequests.
 */
export class SubrequestBudget {
  private used = 0;
  constructor(readonly limit: number) {}

  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  get remaining(): number {
    return this.limit - this.used;
  }
}

export class BudgetExhausted extends Error {
  constructor() {
    super('Subrequest budget exhausted');
  }
}
