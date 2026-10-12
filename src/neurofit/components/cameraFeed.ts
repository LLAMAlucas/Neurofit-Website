/**
 * The live coach's <video>, for whoever wants to look at the feed without owning it — the menu's
 * ASCII mirror of the lifter. CoachCamera registers it while the camera is live and clears it when
 * it unmounts, so a reader never holds a stopped stream.
 */
let feed: HTMLVideoElement | null = null;

export function setCameraFeed(video: HTMLVideoElement | null): void {
  feed = video;
}

/** The feed, once it has a frame to draw; otherwise null. */
export function cameraFeed(): HTMLVideoElement | null {
  return feed && feed.readyState >= 2 && feed.videoWidth > 0 ? feed : null;
}
