package permission

import "reflect"

// reflectFuncEq compares two function values by their underlying code
// pointer. Function values aren't directly comparable with ==, but
// reflect.Value.Pointer is stable enough to match the same callback
// at Subscribe-time vs cancel-time.
func reflectFuncEq(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	va := reflect.ValueOf(a)
	vb := reflect.ValueOf(b)
	if va.Kind() != reflect.Func || vb.Kind() != reflect.Func {
		return false
	}
	return va.Pointer() == vb.Pointer()
}
