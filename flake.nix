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

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ cargo rustc clippy rustfmt rust-analyzer ];
      };
    };
}
