export function byId<T extends HTMLElement = any>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function qs<T extends Element = any>(parent: ParentNode | null | undefined, selector: string): T | null {
  return parent ? (parent.querySelector(selector) as T | null) : null;
}

export function qsa<T extends Element = any>(parent: ParentNode | null | undefined, selector: string): T[] {
  return parent ? (Array.from(parent.querySelectorAll(selector)) as T[]) : [];
}

export function targetEl<T extends HTMLElement = any>(e: Event | null | undefined): T | null {
  return e ? (e.target as T | null) : null;
}
