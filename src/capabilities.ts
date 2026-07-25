const ABI_VERSION = "1.0.0";

export function capabilities(): Record<string, unknown> {
  return { abi_version: ABI_VERSION };
}
