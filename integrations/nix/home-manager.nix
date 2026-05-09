{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.opencode-augment-provider;

  pkg = import ./packages/opencode-augment-provider.nix { inherit lib pkgs; };

  modelType = lib.types.submodule {
    options = {
      name = lib.mkOption {
        type = lib.types.str;
        description = "Display name shown in OpenCode's model picker.";
      };
      limit = lib.mkOption {
        type = lib.types.submodule {
          options = {
            context = lib.mkOption {
              type = lib.types.int;
              description = "Maximum context window in tokens.";
            };
            output = lib.mkOption {
              type = lib.types.int;
              description = "Maximum output tokens per response.";
            };
          };
        };
        description = "Token limits for this model.";
      };
    };
  };
in
{
  options.programs.opencode-augment-provider = {
    enable = lib.mkEnableOption "OpenCode Augment AI provider";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkg;
      defaultText = lib.literalExpression "opencode-augment-provider derivation";
      description = ''
        The opencode-augment-provider package to use. Defaults to the derivation
        built from the flake's source. Override to supply a pre-built package.
      '';
    };

    models = lib.mkOption {
      type = lib.types.attrsOf modelType;
      defaultText = lib.literalExpression "known Augment Code models with context and output limits";
      description = ''
        Models to register under the augment provider in OpenCode. The default
        set covers all models currently available through Augment Code. Override
        to add new models, change limits, or remove entries.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Writes the complete augment provider block into OpenCode's settings.
    # Enabling this module is the single place to configure the provider:
    # npm path, display name, and all models are set here together.
    #
    # NOTE: remove any existing programs.opencode.settings.provider.augment
    # definitions from your nix-config before enabling this module to avoid
    # NixOS module system conflicts on the same option key.
    programs.opencode.settings.provider.augment = {
      name = "Augment Code";
      npm = "file://${cfg.package}/lib/opencode-augment-provider";
      models = cfg.models;
    };
  };
}
