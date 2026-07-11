export function shouldInvokeTauri(hasTauriInternals: boolean, mode: string) {
  return hasTauriInternals || mode === "test";
}
