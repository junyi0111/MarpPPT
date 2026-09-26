export interface HttpAdmissionOptions {
  maxActiveRequests: number;
  maxActiveJobs: number;
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createHttpAdmission(options: HttpAdmissionOptions): {
  readonly maxActiveJobs: number;
  tryAcquireRequest(): (() => void) | undefined;
  tryAcquireJob(): (() => void) | undefined;
  tryAcquireJobs(count: number): (() => void) | undefined;
} {
  if (!validLimit(options.maxActiveRequests) || !validLimit(options.maxActiveJobs) || options.maxActiveJobs > options.maxActiveRequests) {
    throw new RangeError("HTTP request and job limits must be positive integers, with jobs no greater than requests.");
  }
  let activeRequests = 0;
  let activeJobs = 0;
  const acquire = (kind: "request" | "job"): (() => void) | undefined => {
    const count = kind === "request" ? activeRequests : activeJobs;
    const limit = kind === "request" ? options.maxActiveRequests : options.maxActiveJobs;
    if (count >= limit) return undefined;
    if (kind === "request") activeRequests += 1;
    else activeJobs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === "request") activeRequests -= 1;
      else activeJobs -= 1;
    };
  };
  return {
    maxActiveJobs: options.maxActiveJobs,
    tryAcquireRequest: () => acquire("request"),
    tryAcquireJob: () => acquire("job"),
    tryAcquireJobs(count) {
      if (!Number.isSafeInteger(count) || count < 0 || activeJobs + count > options.maxActiveJobs) return undefined;
      activeJobs += count;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeJobs -= count;
      };
    },
  };
}

export async function withRenderJobAdmission<T>(
  acquire: (() => (() => void) | undefined) | undefined,
  operation: (deferReleaseUntil: (pending: Promise<unknown>) => void) => Promise<T>,
  rejected: () => T,
): Promise<T> {
  if (!acquire) return operation(() => undefined);
  const release = acquire();
  if (!release) return rejected();
  let deferred: Promise<unknown> | undefined;
  try {
    return await operation((pending) => { deferred = pending; });
  } finally {
    if (deferred) void deferred.then(release, release);
    else release();
  }
}
