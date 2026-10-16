import { Inject, Injectable } from '@nestjs/common';

export const PROMOTIONS_DEPENDENCY_PROBES = Symbol(
  'PROMOTIONS_DEPENDENCY_PROBES',
);

export interface DependencyProbe {
  check(signal: AbortSignal): Promise<void>;
}

export type PromotionsDependencyProbes = Readonly<
  Partial<Record<'database' | 'broker', DependencyProbe>>
>;

type DependencyStatus = 'up' | 'down' | 'not_implemented';

@Injectable()
export class PromotionsReadinessService {
  constructor(
    @Inject(PROMOTIONS_DEPENDENCY_PROBES)
    private readonly probes: PromotionsDependencyProbes,
  ) {}

  async check() {
    const [database, broker] = await Promise.all([
      this.checkDependency(this.probes.database),
      this.checkDependency(this.probes.broker),
    ]);
    return {
      status: database === 'up' && broker === 'up' ? 'ready' : 'not_ready',
      service: 'promotions-svc',
      dependencies: { database, broker },
    };
  }

  private async checkDependency(
    probe: DependencyProbe | undefined,
  ): Promise<DependencyStatus> {
    if (!probe) return 'not_implemented';
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => probe.check(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Dependency probe timed out'));
          }, 1000);
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
