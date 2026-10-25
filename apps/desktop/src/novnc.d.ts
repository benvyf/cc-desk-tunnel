declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
  }
}
