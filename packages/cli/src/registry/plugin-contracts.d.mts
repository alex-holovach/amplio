export interface HydratableRegistryFile {
  path: string;
  content?: string;
}

export interface HydratableRegistryItem {
  name: string;
  kind?: string;
  files: HydratableRegistryFile[];
}

export function hydrateRegistryPluginContracts<
  Item extends HydratableRegistryItem,
>(items: Item[]): Item[];
