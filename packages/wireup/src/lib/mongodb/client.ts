/**
 * No-op Mongo client — kept so the (replaced) repository layer's import paths
 * resolve. The wireup engine never talks to MongoDB in Forge.
 */

export async function connectMongo(): Promise<void> {
  // nothing to connect to
}