package prompttmpl

import (
	"bytes"
	"text/template"
)

func Parse(name, source string, funcs template.FuncMap) (*template.Template, error) {
	t := template.New(name).Option("missingkey=error")
	if funcs != nil {
		t = t.Funcs(funcs)
	}
	return t.Parse(source)
}

func MustParse(name, source string, funcs template.FuncMap) *template.Template {
	t, err := Parse(name, source, funcs)
	if err != nil {
		panic(err)
	}
	return t
}

func Render(t *template.Template, data any) (string, error) {
	var b bytes.Buffer
	if err := t.Execute(&b, data); err != nil {
		return "", err
	}
	return b.String(), nil
}
