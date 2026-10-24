// Both the node and control center derive the display number from the existing full account ID.
// The full SHA256 remains the registry key; no allocation service or extra provider request is needed.
export function accountNumberFromId(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid account ID');
  return 'CC-' + id.slice(0, 16).toUpperCase().match(/.{4}/g)!.join('-');
}
