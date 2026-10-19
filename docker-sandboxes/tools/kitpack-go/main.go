// kitpack-go packs a v2 kit directory into the inline artifact JSON the
// Sandboxes API accepts (KitArtifactInput.inline), using the reference Go
// implementation from docker/sbx-kits-contrib. The Python provisioner carries
// its own packer; this tool regenerates the goldens that pin the two together.
//
//	go run . <kit-dir> > artifact.json
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/docker/sbx-kits-contrib/spec"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: kitpack-go <kit-dir>")
		os.Exit(2)
	}
	artifact, err := spec.LoadFromDirectory(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Warnings are diagnostics for the author, not part of what a backend applies.
	artifact.Warnings = nil
	out, err := json.MarshalIndent(artifact, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Stdout.Write(append(out, '\n'))
}
