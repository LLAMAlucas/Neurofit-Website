import { Component, type ReactNode } from "react";

/**
 * WebGL can fail for reasons that have nothing to do with this code — a
 * blocklisted driver, a lost context, software rendering disabled. R3F throws in
 * those cases, which would take the page down, so whatever is behind this
 * retires and the section falls back to its flat version.
 *
 * Shared by both scenes on the page: the hero rig, which hands the hero back its
 * 2D lens, and the planes figure, which hands the section back its two drawings.
 * One failure mode, one boundary.
 */
export default class GLBoundary extends Component<{ onFail: () => void; children: ReactNode }> {
  static getDerivedStateFromError() {
    return {};
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.props.children;
  }
}
