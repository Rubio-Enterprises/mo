package server

import "testing"

func TestDetectFileType(t *testing.T) {
	tests := []struct {
		path string
		want FileType
	}{
		// Markdown
		{"/docs/README.md", FileTypeMarkdown},
		{"/docs/page.mdx", FileTypeMarkdown},
		{"/docs/notes.markdown", FileTypeMarkdown},
		{"/docs/notes.mdown", FileTypeMarkdown},
		{"/docs/notes.mkdn", FileTypeMarkdown},
		{"/docs/notes.mkd", FileTypeMarkdown},

		// PDF
		{"/files/report.pdf", FileTypePDF},

		// Image
		{"/img/photo.png", FileTypeImage},
		{"/img/photo.jpg", FileTypeImage},
		{"/img/photo.jpeg", FileTypeImage},
		{"/img/photo.gif", FileTypeImage},
		{"/img/photo.webp", FileTypeImage},
		{"/img/icon.ico", FileTypeImage},
		{"/img/icon.bmp", FileTypeImage},

		// Code
		{"/src/main.go", FileTypeCode},
		{"/src/app.ts", FileTypeCode},
		{"/src/style.css", FileTypeCode},
		{"/src/config.json", FileTypeCode},
		{"/src/data.yaml", FileTypeCode},
		{"/src/image.svg", FileTypeCode},
		{"/Dockerfile", FileTypeCode},
		{"/Makefile", FileTypeCode},

		// Unknown
		{"/files/data.xyz", FileTypeUnknown},
		{"/files/noext", FileTypeUnknown},
		{"/.gitignore", FileTypeUnknown},

		// Case insensitivity
		{"/docs/README.MD", FileTypeMarkdown},
		{"/files/report.PDF", FileTypePDF},
		{"/img/photo.PNG", FileTypeImage},
		{"/src/main.Go", FileTypeCode},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := DetectFileType(tt.path)
			if got != tt.want {
				t.Errorf("DetectFileType(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestDetectFileType_NeverReturnsBinary(t *testing.T) {
	// FileTypeBinary is only produced by promotion in AddFile, never by DetectFileType.
	paths := []string{"/a.bin", "/b.exe", "/c.dll", "/d.so", "/e.dat", "/f"}
	for _, p := range paths {
		got := DetectFileType(p)
		if got == FileTypeBinary {
			t.Errorf("DetectFileType(%q) = %q, must never return FileTypeBinary", p, got)
		}
	}
}
