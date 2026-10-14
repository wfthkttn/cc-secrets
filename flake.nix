{
  description = "secrets: passwords typed in Claude Code reach the command, never the agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      packages.${system}.default = pkgs.rustPlatform.buildRustPackage {
        pname = "secrets";
        version = "0.1.0";
        src = self;
        cargoLock.lockFile = ./Cargo.lock;
        # the ssh-agent tests sign and verify with ssh-keygen and forward to a real ssh-agent
        nativeCheckInputs = [ pkgs.openssh ];
        # In the working copy claude-code/bin points at cargo's target dir; the package points it at the built helpers.
        postInstall = ''
          mkdir -p $out/share/secrets
          cp -r claude-code $out/share/secrets/claude-code
          rm $out/share/secrets/claude-code/bin
          mkdir $out/share/secrets/claude-code/bin
          ln -s $out/bin/* $out/share/secrets/claude-code/bin/
        '';
      };

      # The plugin lands at /run/current-system/sw/share/secrets/claude-code, a path that stays put across rebuilds.
      nixosModules.default = { config, lib, ... }:
        let cfg = config.services.claude-secrets;
        in {
          options.services.claude-secrets = {
            enable = lib.mkEnableOption "the secrets vault daemon for Claude Code";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.default;
              description = "The secrets package; the plugin's bin/ and the daemon must come from the same one.";
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
                ExecStart = "${cfg.package}/bin/secrets-relay daemon";
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
