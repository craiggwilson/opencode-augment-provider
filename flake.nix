{
  description = "opencode-augment-provider — Vercel AI SDK provider routing requests through the Augment AI SDK";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";

    substrate = {
      url = "git+file:///home/craig/Projects/hdwlinux/substrate";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ ... }:
    inputs.substrate.build.with-flake-parts { inherit inputs; } {
      imports = [
        inputs.substrate.substrateModules.overlays
        inputs.substrate.substrateModules.packages
        inputs.substrate.substrateModules.published-modules
        inputs.substrate.substrateModules.shells
      ];

      substrate.settings = {
        packageNamespace = "opencode-augment-provider";

        publish = {
          packages = [ ./integrations/nix/packages/opencode-augment-provider.nix ];

          shells = [ ./integrations/nix/shells/default.nix ];

          homeManagerModules.default = ./integrations/nix/home-manager.nix;
        };
      };
    };
}
