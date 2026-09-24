{
  description = "Reproducible benchmark for the Stanza zero-regex X12/NDJSON streaming parser";

  # Pinned to the nixpkgs revision the other Stanza repos use.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/ef34387ddd751e1ab8857adf4676492d32eb24ec";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      helpText = ''
        # Stanza streaming parser benchmark

        Reproducible benchmark for the zero-regex X12 streaming parser. All data
        is generated locally and is synthetic; no PHI, no customer data.

        ## Try it

            nix run .#smoke          generate ~5 MB and run it under a 25 MB cap
            nix run .#help           this text

        With no checkout:

            nix run github:StanzaAPI/benchmark-harness#smoke

        ## Full runs

            nix run .#generate -- --transactions 255000 --claims 5 --out data/claims.x12
            nix run .#bench    -- data/claims.x12
            nix run .#compare  -- --file data/claims.x12 --cap 25

        generate and bench write to the current directory. smoke works in a temp
        directory and cleans up after itself.

        ## What it measures

        - wall time to stream one file through iterateX12StreamFrames;
        - peak sampled V8 heap and whether the run finishes under a hard
          --max-old-space-size=25 cap;
        - records per second, where one record is one X12 transaction.

        Read README.md for the reference results and COMPARISON.md for the
        head-to-head against node-x12 and x12-parser.
      '';

      tools =
        pkgs:
        let
          node = pkgs.nodejs;
          # Hermetic build: node_modules and dist/ come from the lockfile, so
          # running the apps needs no npm install and no network.
          harness = pkgs.buildNpmPackage {
            pname = "stanza-benchmark-harness";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-XQcxP9ke6wmRMIqCAUqIP3X0YIocUfJctmE+g2OztSk=";
            npmBuildScript = "build";
            meta.description = "Reproducible benchmark for the Stanza X12 streaming parser";
          };
          dir = "${harness}/lib/node_modules/stanza-benchmark-harness";
          mkApp =
            name: extra: text:
            pkgs.writeShellApplication {
              inherit name text;
              runtimeInputs = [
                node
                pkgs.coreutils
              ]
              ++ extra;
            };
          apps = {
            help = mkApp "help" [ pkgs.glow ] ''
              exec glow -s dark ${pkgs.writeText "benchmark-help.md" helpText}
            '';

            generate = mkApp "generate" [ ] ''
              exec node ${dir}/bin/generate.mjs "$@"
            '';

            bench = mkApp "bench" [ ] ''
              file="''${1:-}"
              if [ -z "$file" ]; then
                echo "usage: nix run .#bench -- <file.x12>" >&2
                exit 2
              fi
              exec node --max-old-space-size=25 ${dir}/bin/run.mjs "$file"
            '';

            compare = mkApp "compare" [ ] ''
              exec node ${dir}/bin/compare.mjs "$@"
            '';

            # The one command a stranger runs: generate a small file in a temp
            # directory, run it under the cap, clean up.
            smoke = mkApp "smoke" [ ] ''
              tmp=$(mktemp -d)
              trap 'rm -rf "$tmp"' EXIT
              node ${dir}/bin/generate.mjs --transactions 5000 --claims 5 --out "$tmp/smoke.x12"
              exec node --max-old-space-size=25 ${dir}/bin/run.mjs "$tmp/smoke.x12"
            '';
          };
        in
        {
          inherit harness apps;
        };
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          t = tools pkgs;
        in
        t.apps // { default = t.harness; }
      );

      apps = forAllSystems (
        pkgs:
        lib.mapAttrs (_: drv: {
          type = "app";
          program = lib.getExe drv;
        }) (tools pkgs).apps
      );

      checks = forAllSystems (pkgs: {
        smoke =
          pkgs.runCommand "benchmark-smoke"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
            }
            ''
              dir=${(tools pkgs).harness}/lib/node_modules/stanza-benchmark-harness
              node "$dir/bin/generate.mjs" --transactions 2000 --claims 4 --out smoke.x12
              node --max-old-space-size=25 "$dir/bin/run.mjs" smoke.x12
              touch $out
            '';
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
