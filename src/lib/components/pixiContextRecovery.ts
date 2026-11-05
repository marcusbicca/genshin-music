/**
 * A high-DPI WebGL buffer grows with the SQUARE of the device-pixel ratio. iPhones commonly
 * report 3, which makes each Pixi surface nine physical pixels per CSS pixel and makes Safari
 * considerably more likely to reclaim its context while the page is backgrounded. Two keeps the
 * canvas sharp while putting a hard ceiling on that GPU-memory multiplier.
 */
export function pixiResolution(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

/**
 * Give Pixi/WebKit a chance to restore the existing context before replacing the renderer. The
 * clock only runs while the page is visible: iOS deliberately suspends background pages, so a
 * timeout spent there says nothing about whether restoration is stuck.
 */
export const WEBGL_CONTEXT_RECOVERY_TIMEOUT_MS = 4_000;

export interface WebGLContextRecoveryCallbacks {
  onLost: () => void;
  onRestored: () => void;
  onRecoveryTimeout: () => void;
  /**
   * Whether the context is lost right now, read when the page comes back to the foreground. Some
   * mobile browsers (iOS Safari, several Android WebViews) drop a background page's context
   * without ever dispatching `webglcontextlost`; asking is the only way to notice.
   */
  isContextLost?: () => boolean;
  /**
   * The page is visible again and the context is NOT lost. Mobile browsers may still have
   * discarded the canvas' pixels while the page was hidden, and a renderer that only paints on
   * demand would then show an empty canvas until something else asked for a frame - so the owner
   * repaints everything here.
   */
  onResume?: () => void;
}

/**
 * How long after the page becomes visible the resume check runs: the GPU process of a mobile
 * browser can take a moment to hand the context back, and a check made in the same task as
 * `visibilitychange` may see a context that is about to be reported lost.
 */
export const WEBGL_RESUME_CHECK_DELAY_MS = 250;

/**
 * Observe the browser-level context lifecycle that sits below Pixi.
 *
 * Pixi installs its own listeners during Application.init(), before this is called. Its restored
 * listener therefore rebuilds Pixi's renderer systems first; onRestored can then safely recreate
 * application-owned RenderTextures, whose pixels the WebGL specification says are invalid after a
 * restoration.
 */
export function observeWebGLContext(
  canvas: HTMLCanvasElement,
  callbacks: WebGLContextRecoveryCallbacks
): () => void {
  let lost = false;
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const clearRecoveryTimeout = () => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
  };

  const scheduleRecoveryTimeout = () => {
    clearRecoveryTimeout();
    if (disposed || !lost || document.visibilityState !== 'visible') return;
    timeout = setTimeout(() => {
      timeout = null;
      if (!disposed && lost && document.visibilityState === 'visible') {
        callbacks.onRecoveryTimeout();
      }
    }, WEBGL_CONTEXT_RECOVERY_TIMEOUT_MS);
  };

  const handleContextLost = (event: Event) => {
    // Required by WebGL for the user agent to attempt restoration. Pixi also does this, but doing
    // it here makes the recovery contract explicit and keeps it true if Pixi's internals change.
    event.preventDefault();
    if (lost) return;
    lost = true;
    callbacks.onLost();
    scheduleRecoveryTimeout();
  };

  const handleContextRestored = () => {
    if (!lost) return;
    lost = false;
    clearRecoveryTimeout();
    callbacks.onRestored();
  };

  let resumeCheck: ReturnType<typeof setTimeout> | null = null;
  const clearResumeCheck = () => {
    if (resumeCheck !== null) clearTimeout(resumeCheck);
    resumeCheck = null;
  };
  const scheduleResumeCheck = () => {
    clearResumeCheck();
    resumeCheck = setTimeout(() => {
      resumeCheck = null;
      if (disposed || document.visibilityState !== 'visible') return;
      // a loss the browser never announced: run the same path an announced one takes
      if (!lost && callbacks.isContextLost?.()) {
        lost = true;
        callbacks.onLost();
        scheduleRecoveryTimeout();
        return;
      }
      if (!lost) callbacks.onResume?.();
    }, WEBGL_RESUME_CHECK_DELAY_MS);
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      scheduleRecoveryTimeout();
      scheduleResumeCheck();
    } else {
      clearRecoveryTimeout();
      clearResumeCheck();
    }
  };

  const handlePageShow = () => {
    scheduleRecoveryTimeout();
    scheduleResumeCheck();
  };

  canvas.addEventListener('webglcontextlost', handleContextLost);
  canvas.addEventListener('webglcontextrestored', handleContextRestored);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handlePageShow);

  return () => {
    disposed = true;
    clearRecoveryTimeout();
    clearResumeCheck();
    canvas.removeEventListener('webglcontextlost', handleContextLost);
    canvas.removeEventListener('webglcontextrestored', handleContextRestored);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pageshow', handlePageShow);
  };
}
