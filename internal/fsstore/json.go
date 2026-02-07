package fsstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

func ReadJSON(path string, out any) (bool, error) {
	normalizedPath, err := normalizePath(path)
	if err != nil {
		return false, err
	}
	data, err := os.ReadFile(normalizedPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("read json %s: %w", normalizedPath, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return false, nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false, fmt.Errorf("%w: decode %s: %v", ErrDecodeFailed, normalizedPath, err)
	}
	return true, nil
}

func WriteJSONAtomic(path string, v any, opts FileOptions) error {
	normalizedPath, err := normalizePath(path)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: encode %s: %v", ErrEncodeFailed, normalizedPath, err)
	}
	data = append(data, '\n')
	return writeAtomic(normalizedPath, data, opts)
}
