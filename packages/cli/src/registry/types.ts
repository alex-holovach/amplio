export interface RegistryFile {
  path: string;
  type: string;
  target?: string;
  content?: string;
}

export interface RegistryTestedProviderVersion {
  minimum: string;
  latest: string;
}

export type RegistryPluginProvider =
  | {
      package: string;
      instrumenter: string;
      seam?: "constructor";
      constructor: string;
    }
  | {
      package: string;
      instrumenter: string;
      seam: "trpc-middleware";
      initializer: "initTRPC";
    }
  | {
      package: string;
      instrumenter: string;
      seam: "better-auth-plugin";
      factory: "betterAuth";
    }
  | {
      package: string;
      instrumenter: string;
      seam: "telemetry-registration";
      registrar: "registerTelemetry";
    };

export interface RegistryItem {
  name: string;
  type: string;
  title?: string;
  description?: string;
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
  kind?: "event" | "plugin" | string;
  role?: "boundary" | "contributor";
  recipeVersion?: string;
  coreRange?: string;
  providerRanges?: Record<string, string>;
  testedProviderVersions?: Record<string, RegistryTestedProviderVersion>;
  events?: Array<{
    id: string;
    version: number;
    semanticDigest?: string;
  }>;
  semanticDigest?: string;
  nativeTransform?: {
    version: number;
    digest?: string;
  };
  placement?: { branch: string };
  provider?: RegistryPluginProvider;
  wiringActions?: Array<{
    type: string;
    description: string;
    export?: string;
  }>;
  privacy?: { includes: string[]; excludes: string[] };
  files: RegistryFile[];
}

export interface RegistryManifest {
  $schema?: string;
  name: string;
  homepage?: string;
  items: RegistryItem[];
}
