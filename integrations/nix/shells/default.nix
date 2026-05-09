{ pkgs, ... }:
pkgs.mkShell {
  packages = [
    pkgs.bun
    pkgs.nixfmt-rfc-style
    pkgs.nodejs
  ];
}
