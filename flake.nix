{
  description = "secrets: passwords typed in Claude Code reach the command, never the agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (nixpkgs) lib;
      # Built from the Rust sources alone: a change to the plugin's hooks leaves the daemon, and so the open vault, as
      # they are across a rebuild.
      daemon = pkgs.rustPlatform.buildRustPackage {
        pname = "secrets-daemon";
        version = "0.1.0";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./clippy.toml ./src ./tests ./claude-code/tests/mask-cases.ts ];
        };
        cargoLock.lockFile = ./Cargo.lock;
        # the ssh-agent tests sign and verify with ssh-keygen and forward to a real ssh-agent
        nativeCheckInputs = [ pkgs.openssh ];
      };
    in {
      # The plugin, with the daemon's programs on PATH and in its bin/, where the working copy points at cargo's target
      # dir instead.
      packages.${system}.default = pkgs.runCommand "secrets-0.1.0" { passthru = { inherit daemon; }; } ''
        mkdir -p $out/share/secrets $out/bin
        cp -r ${./claude-code} $out/share/secrets/claude-code
        chmod -R u+w $out/share/secrets/claude-code
        rm $out/share/secrets/claude-code/bin
        mkdir $out/share/secrets/claude-code/bin
        ln -s ${daemon}/bin/* $out/share/secrets/claude-code/bin/
        ln -s ${daemon}/bin/* $out/bin/
      '';

      # The plugin lands at /run/current-system/sw/share/secrets/claude-code, a path that stays put across rebuilds.
      nixosModules.default = { config, lib, ... }:
        let cfg = config.services.claude-secrets;
        in {
          options.services.claude-secrets = {
            enable = lib.mkEnableOption "the secrets vault daemon for Claude Code";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.default;
              description = "The secrets package; the daemon runs from its `daemon`, the one the plugin's bin/ links to.";
            };
          };
          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];
            environment.pathsToLink = [ "/share/secrets" ];
            # one vault for every session: the first session's attach starts the daemon; systemd holds the socket
            # across restarts, so attaches made meanwhile queue instead of failing
            systemd.user.sockets.secrets = {
              description = "secrets vault daemon socket";
              wantedBy = [ "sockets.target" ];
              listenStreams = [ "%t/secrets.sock" ];
              socketConfig.SocketMode = "0600";
            };
            systemd.user.services.secrets = {
              description = "secrets vault daemon";
              serviceConfig = {
                ExecStart = "${cfg.package.daemon}/bin/secrets-relay daemon";
                Restart = "on-failure";
                RestartSec = 5;
              };
            };
          };
        };

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ cargo rustc clippy rustfmt rust-analyzer ];
      };
    };
}
