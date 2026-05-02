package sessions

import "reflect"

// reflectFuncPointer returns the underlying code pointer for a Go
// function value. Function values aren't directly comparable with ==
// (the spec leaves it undefined), but reflect's Pointer() method
// gives us a stable handle that satisfies the use case here:
// matching the same callback at Subscribe vs cancel().
func reflectFuncPointer(fn any) uintptr {
	v := reflect.ValueOf(fn)
	if v.Kind() != reflect.Func {
		return 0
	}
	return v.Pointer()
}
