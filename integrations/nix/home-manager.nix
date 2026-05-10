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
      default = { };
      defaultText = lib.literalExpression "{ }";
      description = ''
        Models to register under the augment provider in OpenCode's settings.

        When empty (the default), no provider block is written and the plugin
        discovers the model list from Augment's get-models API at runtime. Set
        this only when you want to bypass runtime discovery and manage the model
        list explicitly.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    programs.opencode.settings = lib.mkMerge [
      # Always register the plugin so it can inject npm, logging, and runtime
      # model discovery.
      {
        plugin = [
          "file:///home/craig/Projects/hdwlinux/opencode-augment-provider"
        ];
      }

      # Only write the provider block when the user has explicitly configured
      # models. When models is empty the plugin discovers them at runtime, so no
      # static provider block is needed.
      #
      # NOTE: if you do set models here, remove any existing
      # programs.opencode.settings.provider.augment definitions from your
      # nix-config to avoid NixOS module system conflicts on the same key.
      (lib.mkIf (cfg.models != { }) {
        provider.augment = {
          name = "Augment Code";
          models = cfg.models;
        };
      })
    ];
  };
}
