{ lib, pkgs, ... }:
let
  # Phase 1: fetch production node_modules as a fixed-output derivation.
  # Only runtime deps are fetched (--production), keeping the hash stable.
  nodeModules = pkgs.stdenvNoCC.mkDerivation {
    name = "opencode-augment-provider-node-modules";

    src = lib.fileset.toSource {
      root = ../../..;
      fileset = lib.fileset.unions [
        ../../../package.json
        ../../../bun.lock
      ];
    };

    nativeBuildInputs = [ pkgs.bun ];

    # Allow proxy environment variables through the Nix sandbox for network access.
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
      bun install --frozen-lockfile --ignore-scripts --production --no-progress
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/
      runHook postInstall
    '';

    dontFixup = true;

    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = "sha256-egvMp6lj+GHkTv3b5tYHljITUIMQqPBUCeyeU3kd/YY=";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "opencode-augment-provider";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../src
      ../../../package.json
      ../../../tsconfig.json
      ../../../bun.lock
    ];
  };

  nativeBuildInputs = [ pkgs.bun ];

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -r ${nodeModules}/node_modules .
    bun build src/index.ts --outdir dist --target node --bundle
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/opencode-augment-provider/dist
    cp dist/index.js $out/lib/opencode-augment-provider/dist/
    cp package.json $out/lib/opencode-augment-provider/
    runHook postInstall
  '';

  meta = {
    description = "OpenCode provider implementation using Augment AI SDK";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
