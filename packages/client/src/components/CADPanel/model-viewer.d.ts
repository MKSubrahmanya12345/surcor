import type * as React from "react";
/**
 * `<model-viewer>` is a single web component (@google/model-viewer, Apache-2.0)
 * — React has no intrinsic for it, so the attributes Forge actually uses are
 * declared here instead of casting every element to `any`.
 */
export interface ModelViewerAttributes extends React.HTMLAttributes<HTMLElement> {
  src?: string;
  alt?: string;
  poster?: string;
  "camera-controls"?: boolean;
  "touch-action"?: "none" | "pan-y" | "rotate" | "auto";
  "orbit-sensitivity"?: number;
  "min-camera-orbit"?: string;
  "max-camera-orbit"?: string;
  "interaction-prompt"?: "none" | "auto" | "focus";
  "auto-rotate"?: boolean;
  "auto-rotate-delay"?: number;
  "rotation-per-second"?: string;
  "camera-orbit"?: string;
  "field-of-view"?: string;
  "model-transform"?: string;
  "shadow-intensity"?: number | string;
  "shadow-softness"?: number | string;
  exposure?: number | string;
  "environment-image"?: string;
  loading?: "auto" | "lazy" | "eager";
  reveal?: "auto" | "manual";
  ar?: boolean;
  "ar-modes"?: string;
  "scale"?: string;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": ModelViewerAttributes;
    }
  }
}
