/**
 * The signed-in user. Placeholder until GitHub OIDC lands (plan phase 4):
 * everyone is "dev".
 */
export async function currentUserId(): Promise<string> {
  return "dev";
}
